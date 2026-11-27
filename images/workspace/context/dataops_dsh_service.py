#!/usr/bin/env python3
"""Manage the DataOps-owned DeepSeek Harness Plus Web process inside one workspace.

The service is intentionally loopback-only. Browser ingress belongs to the DataOps
Workspace Web Gateway; this helper only owns local process lifecycle and readiness.
"""

import argparse
import datetime
import fcntl
import http.client
import json
import os
import pathlib
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
import traceback
import urllib.request
import uuid
from datetime import timezone


DEFAULT_WORKSPACE_ROOT = "/workspace"
WORKSPACE_MOUNT_PATH_ENV = "DATAOPS_AI_WORKSPACE_MOUNT_PATH"
DSH_HOME_ENV = "DATAOPS_DSH_HOME"
MOUNTINFO_PATH = pathlib.Path("/proc/self/mountinfo")
ROOT_MOUNT_POINT = "/"


# 卷挂载点是容器内的绝对路径。相对或空值此前会走 Path.resolve()，以进程 cwd（root 用户
# 是 /root）为基准拼出 /root/workspace —— 位于持久卷之外。DSH 会把该路径当作工作区根注册，
# 于是会话按新路径重新分组，之后容器重建就会销毁建在那里的工作区。
def resolve_workspace_root():
    configured = os.environ.get(WORKSPACE_MOUNT_PATH_ENV, "").strip()
    if not configured:
        return pathlib.Path(DEFAULT_WORKSPACE_ROOT)
    candidate = pathlib.Path(configured)
    if not candidate.is_absolute():
        # 后端只下发卷挂载路径；相对值无法定位到卷，回落到默认挂载点而不是当前目录。
        return pathlib.Path(DEFAULT_WORKSPACE_ROOT)
    return candidate


def resolve_dsh_home(workspace_root):
    configured = os.environ.get(DSH_HOME_ENV, "").strip()
    if not configured:
        return workspace_root / ".dataops" / "dsh"
    candidate = pathlib.Path(configured)
    if not candidate.is_absolute():
        return workspace_root / ".dataops" / "dsh"
    return candidate


WORKSPACE_ROOT = resolve_workspace_root().resolve()
DSH_HOME = resolve_dsh_home(WORKSPACE_ROOT).resolve()
DSH_ROOT = pathlib.Path(os.environ.get("DATAOPS_DSH_ROOT", "/opt/dsh-plus")).resolve()
# DSH's runtime and dependency closure live in the immutable image installation.
DSH_ENTRY = DSH_ROOT / "node_modules" / "@deepseek-ai" / "dsh" / "lib" / "bin.js"
DSH_HOST = os.environ.get("DATAOPS_DSH_HOST", "127.0.0.1").strip() or "127.0.0.1"
DSH_PORT = int(os.environ.get("DATAOPS_DSH_PORT", "3080"))
DSH_PROFILE = os.environ.get("DATAOPS_DSH_PROFILE", "dataops-web").strip() or "dataops-web"
DSH_PROFILE_TEMPLATE = pathlib.Path(
    os.environ.get("DATAOPS_DSH_PROFILE_TEMPLATE", "/opt/dataops-dsh-profile-template")
).resolve()
# Optional image-provided profile variant, e.g. `im-test`. The variant is a declaration under
# `<template>/profiles/<name>/`, not a second profile tree: it names the packages the image
# already installed plus the dependency/bundle rows that mount them, and `prepare_profile()`
# merges it into a fresh copy of the default template. That keeps one shared dependency tree
# in the image instead of a second 1.4 GB profile copy for every variant.
DSH_PROFILE_VARIANT = os.environ.get("DATAOPS_DSH_PROFILE_VARIANT", "").strip()
PROFILE_VARIANT_DIR = (
    DSH_PROFILE_TEMPLATE / "profiles" / DSH_PROFILE_VARIANT if DSH_PROFILE_VARIANT else None
)
DSH_PROFILE_SOURCE_REF = os.environ.get("DATAOPS_DSH_PROFILE_SOURCE_REF", "").strip()
DSH_INTEGRATION_VERSION = 2
DSH_EMBEDDED_DATAOPS_PATCH = pathlib.Path(
    os.environ.get(
        "DATAOPS_DSH_EMBEDDED_PATCH",
        "/opt/dataops-runtime/src/dataops-dsh-embedded.patch.yml",
    )
).resolve()
START_TIMEOUT_SECONDS = float(os.environ.get("DATAOPS_DSH_START_TIMEOUT_SECONDS", "600"))
STOP_TIMEOUT_SECONDS = float(os.environ.get("DATAOPS_DSH_STOP_TIMEOUT_SECONDS", "10"))
# 一个只有 managed-dataops 插件激活后才会注册的路由，用作「插件树是否挂完」的判据。
# 根页面 "/" 由静态资源 fallback 提供，插件还在激活时它已经返回 200，因此不能拿它判就绪。
PLUGIN_READY_PATH = "/integrations/dataops/model-sync"
# 180 秒是给「冷启动 + 机器正忙」留的余量：实测空机器 boot 到该路由 ~14 秒，但镜像构建收尾
# 时 pypi/apt 会占满 IO，60 秒会在那里误报 starting（2026-10-23 镜像 verify 的真实误判）。
# 判据只影响 start/ensure 等待多久，HTTP 服务在这期间已经可用。
PLUGIN_READY_TIMEOUT_SECONDS = float(
    os.environ.get("DATAOPS_DSH_PLUGIN_READY_TIMEOUT_SECONDS", "180")
)
# 判据路由由 managed-dataops 插件注册，该插件来自镜像里的 profile 模板而非用户选择。
# 若某个 profile 确实不带它（定制镜像、别的发行版），就退回「只看根页面」，
# 免得每次启动都白等一个永远 404 的路由。
PLUGIN_READY_BUNDLE = "@sparkelf/dsh-dataops-managed"
RUNTIME_DIR = DSH_HOME / "runtime"
LOG_DIR = DSH_HOME / "logs"
PID_PATH = RUNTIME_DIR / "web.pid"
LOCK_PATH = RUNTIME_DIR / "service.lock"
LOG_PATH = LOG_DIR / "web.log"
PROFILE_DIR = DSH_HOME / "profiles" / DSH_PROFILE
PROFILE_SOURCE_MARKER = ".dataops-source-ref"
# Whole-profile copies are legacy: the current prepare_profile() replaces the tree in place.
# Keep at most this many valid copies around the active profile, and always drop broken ones.
try:
    PROFILE_BACKUP_KEEP = max(0, int(os.environ.get("DATAOPS_DSH_PROFILE_BACKUP_KEEP", "0")))
except ValueError:
    PROFILE_BACKUP_KEEP = 1
MANAGED_SKILL_CLEANUP_SCRIPT = pathlib.Path(
    os.environ.get(
        "DATAOPS_MANAGED_SKILL_CLEANUP",
        "/usr/local/lib/cleanup-obsolete-managed-skills.mjs",
    )
).resolve()

class ServiceError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))


def profile_source_marker(path):
    """The full marker a profile carries: `version+digest`, or a bare version when absent."""
    marker = path / PROFILE_SOURCE_MARKER
    return marker.read_text("utf-8").strip() if marker.is_file() else ""


def profile_release_version(path):
    """Release a profile came from; the digest half of the marker is not part of it.

    The image compares this against DATAOPS_DSH_PROFILE_SOURCE_REF, which is fixed at build
    time and therefore cannot know a digest. Re-copy is judged on the full marker instead.
    """
    return profile_source_marker(path).split("+", 1)[0]


def mounted_paths():
    """容器内的挂载点集合，用来判断某个目录是否真的落在持久卷上。"""
    mount_points = set()
    try:
        lines = MOUNTINFO_PATH.read_text("utf-8").splitlines()
    except OSError:
        return mount_points
    for line in lines:
        fields = line.split(" ")
        if len(fields) < 5:
            continue
        mount_point = fields[4].replace("\\040", " ")
        mount_points.add(mount_point)
    return mount_points


def is_volume_backed(path):
    """该路径自身或其祖先是否为挂载点；只有挂载点下的内容能跨容器重建存活。"""
    mount_points = mounted_paths()
    if not mount_points:
        # mountinfo 不可读时不阻断启动，交给调用方按 cwd 判据继续。
        return True
    current = path
    while True:
        # 容器根自身也是挂载点，但它属于镜像可写层，不跨容器重建存活。
        if str(current) == ROOT_MOUNT_POINT:
            return False
        if str(current) in mount_points:
            return True
        parent = current.parent
        if parent == current:
            return False
        current = parent


def ensure_workspace_root_is_durable():
    """工作区根必须落在持久卷内，否则容器重建会静默销毁用户的工作区目录。"""
    # 先判持久性：配错的根常常同时不存在，而「不在卷上」才是那个可操作的诊断。
    if not is_volume_backed(WORKSPACE_ROOT):
        raise ServiceError(
            "WORKSPACE_ROOT_NOT_PERSISTED",
            f"Workspace root {WORKSPACE_ROOT} is not on a mounted volume;"
            f" set {WORKSPACE_MOUNT_PATH_ENV} to the volume mount path (default {DEFAULT_WORKSPACE_ROOT}).",
        )
    if not WORKSPACE_ROOT.is_dir():
        raise ServiceError(
            "WORKSPACE_ROOT_MISSING",
            f"Workspace root does not exist: {WORKSPACE_ROOT}",
        )


# Managed DSH runs in the single workspace container; DataOps JWT stays with the managed plugin.
def ensure_contract():
    if DSH_HOST != "127.0.0.1":
        raise ServiceError(
            "DSH_HOST_NOT_LOOPBACK",
            "Embedded DSH must bind to 127.0.0.1; browser ingress belongs to the DataOps gateway.",
        )
    if DSH_PORT < 1 or DSH_PORT > 65535:
        raise ServiceError("DSH_PORT_INVALID", "DATAOPS_DSH_PORT must be between 1 and 65535.")
    if not DSH_HOME.is_relative_to(WORKSPACE_ROOT):
        raise ServiceError(
            "DSH_HOME_OUTSIDE_WORKSPACE",
            "DATAOPS_DSH_HOME must stay inside the durable workspace volume.",
        )
    if not DSH_ENTRY.is_file():
        raise ServiceError(
            "DSH_RUNTIME_MISSING",
            f"Built DSH entry is missing: {DSH_ENTRY}",
        )
    if not DSH_EMBEDDED_DATAOPS_PATCH.is_file():
        raise ServiceError(
            "DSH_EMBEDDED_DATAOPS_PATCH_MISSING",
            f"DataOps embedded DSH overlay is missing: {DSH_EMBEDDED_DATAOPS_PATCH}",
        )
    if not (DSH_PROFILE_TEMPLATE / "package.json").is_file():
        raise ServiceError(
            "DSH_PROFILE_TEMPLATE_MISSING",
            f"DataOps curated DSH profile template is missing: {DSH_PROFILE_TEMPLATE}",
        )
    template_source_ref = profile_release_version(DSH_PROFILE_TEMPLATE)
    if not DSH_PROFILE_SOURCE_REF or template_source_ref != DSH_PROFILE_SOURCE_REF:
        raise ServiceError(
            "DSH_PROFILE_SOURCE_MISMATCH",
            "DataOps curated DSH profile template does not match DATAOPS_DSH_PROFILE_SOURCE_REF.",
        )
    if DSH_PROFILE_VARIANT:
        variant = PROFILE_VARIANT_DIR
        if variant is None or not (variant / "variant.json").is_file():
            raise ServiceError(
                "DSH_PROFILE_VARIANT_MISSING",
                f"Requested DSH profile variant is missing from the image: {variant}",
            )
        variant_source_ref = profile_release_version(variant)
        if variant_source_ref != DSH_PROFILE_SOURCE_REF:
            raise ServiceError(
                "DSH_PROFILE_VARIANT_SOURCE_MISMATCH",
                "DSH profile variant does not match DATAOPS_DSH_PROFILE_SOURCE_REF.",
            )


def prepare_directories():
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    # The workspace web-gateway agent runs as `nobody` and must read the DSH launch token
    # from logs/web.log. Keep $DSH_HOME traversable but not listable; the sensitive files
    # inside stay 0600.
    os.chmod(DSH_HOME, 0o711)
    os.chmod(LOG_DIR, 0o755)
    if LOG_PATH.exists():
        os.chmod(LOG_PATH, 0o644)


WORKSPACE_ENV_SEED_KEYS = (("DATAOPS_EXA_API_KEY", "EXA_API_KEY"),)


def _env_assignment_parts(line):
    """Split a `.env` line into (prefix, key, raw value), or return None."""
    stripped = line.strip()
    if not stripped or stripped.startswith("#"):
        return None
    prefix = ""
    if stripped.startswith("export "):
        prefix = line[: len(line) - len(line.lstrip())] + "export "
        stripped = stripped[len("export ") :].lstrip()
        line = stripped
    if "=" not in stripped:
        return None
    key, _, value = stripped.partition("=")
    key = key.strip()
    if not key or not (key[0].isalpha() or key[0] == "_"):
        return None
    if not all(character.isalnum() or character == "_" for character in key):
        return None
    return prefix, key, value


def _unquote_env_value(raw):
    value = raw.strip()
    if len(value) >= 2 and value.startswith('"') and value.endswith('"'):
        return (
            value[1:-1]
            .replace("\\n", "\n")
            .replace('\\"', '"')
            .replace("\\\\", "\\")
        )
    if len(value) >= 2 and value.startswith("'") and value.endswith("'"):
        return value[1:-1]
    return value


def _format_env_assignment(key, value):
    if re.fullmatch(r"[A-Za-z0-9_./:@+-]+", value):
        return f"{key}={value}"
    escaped = value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")
    return f'{key}="{escaped}"'


def merge_workspace_env_content(existing, entries):
    """Add or replace entries while keeping every unrelated line in place.

    A single matching line with the requested value is left byte-for-byte alone, so repeated
    service starts do not rewrite the file. Duplicate assignments collapse to the first one.
    """
    if not entries:
        return existing
    lines = existing.replace("\r\n", "\n").split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    changed = False
    for key, value in entries.items():
        matches = []
        for index, line in enumerate(lines):
            parsed = _env_assignment_parts(line)
            if parsed is None or parsed[1] != key:
                continue
            matches.append((index, parsed[0], _unquote_env_value(parsed[2])))
        if not matches:
            lines.append(_format_env_assignment(key, value))
            changed = True
            continue
        if len(matches) == 1 and matches[0][2] == value:
            continue
        first_index, first_prefix, _ = matches[0]
        lines[first_index] = first_prefix + _format_env_assignment(key, value)
        for index, _, _ in reversed(matches[1:]):
            del lines[index]
        changed = True
    if not changed:
        return existing
    return ("\n".join(lines) + "\n") if lines else ""


def seed_workspace_env(environ=None):
    """Merge deployment-owned credentials into `$DSH_HOME/.env` with mode 0600.

    app-boot reads this user-env layer once when DSH starts, so the merge happens before the
    process is spawned. Only a non-empty deployment value is written; the value itself never
    reaches the log.
    """
    source = environ if environ is not None else os.environ
    entries = {}
    for source_key, target_key in WORKSPACE_ENV_SEED_KEYS:
        # The deployment hands the value over as DATAOPS_EXA_API_KEY so it never shadows the
        # provider variable app-boot resolves from the user-env layer. EXA_API_KEY stays an
        # accepted alias for manually provisioned containers.
        value = (source.get(source_key) or "").strip()
        if not value:
            value = (source.get(target_key) or "").strip()
        if value:
            entries[target_key] = value
    if not entries:
        return False

    env_path = DSH_HOME / ".env"
    try:
        existing = env_path.read_text("utf-8") if env_path.is_file() else ""
    except OSError as exc:
        log_message(f"workspace env seed skipped: {exc.__class__.__name__}")
        return False
    merged = merge_workspace_env_content(existing, entries)
    if merged == existing and env_path.is_file():
        os.chmod(env_path, 0o600)
        return False

    env_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = env_path.with_name(f".{env_path.name}.tmp-{os.getpid()}")
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(merged)
        os.replace(temporary, env_path)
        os.chmod(env_path, 0o600)
    finally:
        try:
            temporary.unlink()
        except OSError:
            pass
    log_message("workspace .env seeded with EXA_API_KEY (value not logged)")
    return True


def _workspace_session_key(workspace_path: str) -> str:
    """Encode a workspace path the way DSH names its session directory."""
    trimmed = str(workspace_path).strip("/")
    return "--" + trimmed.replace("/", "-") + "--" if trimmed else "--root--"


def workspace_record_timestamp():
    """The ISO-8601 shape ``@deepseek-ai/dsh-workspace`` stamps on its own records."""
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def repair_workspace_record():
    """Point a home-derived DSH workspace at the mounted workspace root.

    DSH registers its first workspace from ``$HOME`` when its store is empty, so a workspace
    first booted without an explicit root keeps ``/root`` (and sessions under it resolve their
    working directory to ``/root/workspace``, outside the durable volume). A later image can
    only correct the record — leaving it alone keeps every old session broken, and rewriting it
    without moving the session directory orphans those sessions instead. Repair both in one
    step, before DSH starts, and back the store up first.
    """
    store = DSH_HOME / "storages" / "workspace.json"
    if not store.is_file():
        return
    try:
        original = store.read_text("utf-8")
        document = json.loads(original)
    except (OSError, ValueError):
        return
    tables = document.get("tables") if isinstance(document, dict) else None
    workspaces = tables.get("workspaces") if isinstance(tables, dict) else None
    if not isinstance(workspaces, dict):
        return
    target = str(WORKSPACE_ROOT)
    home = str(pathlib.Path.home())
    legacy_paths = {home, os.path.join(home, "workspace")}
    if not workspaces:
        # Empty store: DSH would register ``$HOME`` as its first workspace, which sits outside the
        # durable volume. Seed the mounted root instead so the first session is created in the
        # workspace the deployment actually mounted.
        seed = str(uuid.uuid4())
        # `workspaceRecord` requires createdAt and updatedAt as well as path/title/sessionIds; a
        # seed without them makes parseRecord reject the table, the workspace domain refuses to
        # open, and every plugin that injects it (workspace-controller, session-controller,
        # task-bus, group-chat, ...) is left inactive.
        stamp = workspace_record_timestamp()
        workspaces[seed] = {
            "path": target,
            "title": WORKSPACE_ROOT.name,
            "sessionIds": [],
            "createdAt": stamp,
            "updatedAt": stamp,
        }
        global_section = document.get("global") if isinstance(document.get("global"), dict) else None
        if global_section is not None and isinstance(global_section.get("workspaceIds"), list):
            global_section["workspaceIds"].append(seed)
        store.write_text(json.dumps(document, ensure_ascii=False), "utf-8")
        log_message(f"workspace store seeded with {target}")
        return
    repairs = []
    for entry in workspaces.values():
        if not isinstance(entry, dict):
            continue
        current = entry.get("path")
        if isinstance(current, str) and current in legacy_paths and current != target:
            repairs.append(current)
            entry["path"] = target
            entry["title"] = WORKSPACE_ROOT.name
    # Two records can claim the same path (a seeded one plus one DSH created before the seed
    # landed). DSH refuses to start its workspace domain when that happens, so merge them here.
    merged = False
    by_path = {}
    for key in list(workspaces):
        entry = workspaces.get(key)
        path = entry.get("path") if isinstance(entry, dict) else None
        if not isinstance(path, str):
            continue
        keeper = by_path.get(path)
        if keeper is None:
            by_path[path] = key
            continue
        kept = workspaces[keeper]
        kept["sessionIds"] = list(dict.fromkeys(
            (kept.get("sessionIds") or []) + (entry.get("sessionIds") or [])
        ))
        # The survivor can be the older seed, which carried no timestamps; keep the earliest
        # createdAt either record has and always refresh updatedAt by the merge itself.
        stamps = [
            value
            for value in (kept.get("createdAt"), entry.get("createdAt"))
            if isinstance(value, str) and value
        ]
        kept["createdAt"] = min(stamps) if stamps else workspace_record_timestamp()
        kept["updatedAt"] = workspace_record_timestamp()
        workspaces.pop(key, None)
        global_ids = document.get("global", {}).get("workspaceIds")
        if isinstance(global_ids, list) and key in global_ids:
            global_ids.remove(key)
        merged = True
        repairs.append(path)
    if merged and not repairs:
        repairs.append(target)
    # A record written by an older image (or hand-edited) can predate the timestamps. Backfilling
    # them costs nothing on a valid record and is the difference between a workspace domain that
    # opens and one that refuses the whole table.
    stamped = False
    for entry in workspaces.values():
        if not isinstance(entry, dict):
            continue
        stamp = workspace_record_timestamp()
        if not isinstance(entry.get("createdAt"), str) or not entry.get("createdAt"):
            entry["createdAt"] = stamp
            stamped = True
        if not isinstance(entry.get("updatedAt"), str) or not entry.get("updatedAt"):
            entry["updatedAt"] = stamp
            stamped = True
    if stamped:
        repairs.append(target)
    # `global.workspaceIds` is what the registry validates: an id the table no longer holds becomes
    # a phantom workspace, and a phantom that resolves to the same path as a real one stops the
    # whole domain from opening ("path '/workspace' is claimed by both ..."). Drop the ids that
    # name nothing, keep the order of the rest, and rebuild the list when it named only phantoms.
    global_section = document.get("global")
    if isinstance(global_section, dict) and isinstance(global_section.get("workspaceIds"), list):
        declared = [entry for entry in global_section["workspaceIds"] if isinstance(entry, str)]
        present = [entry for entry in declared if entry in workspaces]
        unique = list(dict.fromkeys(present))
        rebuilt = list(workspaces) if not unique else unique
        if rebuilt != declared:
            global_section["workspaceIds"] = rebuilt
            repairs.append(target)
    if not repairs:
        return
    backup = store.with_name(store.name + ".bak-workspace-repair-" + str(int(time.time())))
    try:
        backup.write_text(original, "utf-8")
        store.write_text(json.dumps(document, ensure_ascii=False), "utf-8")
    except OSError as exc:
        log_message(f"workspace record repair skipped: {exc}")
        return
    log_message(
        "workspace record repaired: " + ", ".join(sorted(set(repairs))) + f" -> {target}"
    )


def clear_stale_profile_lock():
    """Drop a profile write lock left behind by a process that no longer owns it.

    The Settings editor serializes every profile write through
    ``<profile>/package.json.lock`` (``@deepseek-ai/dsh-atomic-write``). Its takeover
    probe asks ``process.kill(pid, 0)`` whether the recorded holder is still alive.
    A DSH process killed with SIGKILL stays a zombie under this container's PID 1, so
    that probe keeps succeeding; with container PID reuse the stale record can even
    name an unrelated newer process. Either way the lock is never taken over and every
    later write fails with "atomic-write: timed out waiting for the writer lock": the
    model selector stops persisting, theme and Settings writes fail the same way, and
    the UI shows no error.

    Called immediately before a managed start, after ``start_service`` has established
    that no DSH process of this profile is running (a ready instance returns early, and
    a recorded stale pid is stopped just above). Deleting the file therefore cannot
    cancel a live write.
    """
    for lock in PROFILE_DIR.glob("package.json.lock*"):
        try:
            lock.unlink()
        except OSError:
            pass


def apply_profile_variant(profile_dir, variant_dir):
    """Merge one image profile variant into a freshly copied profile tree.

    The variant only declares what differs from the default profile: the packages the image
    already installed, the dependency and bundle rows that make DSH mount them, and an optional
    ``cordis.patch.yml`` fragment. Package paths are symlinked into the profile because the
    shared dependency tree lives once under ``/opt`` and must not be duplicated per workspace.
    A variant is data, not code: adding another experimental profile is a manifest plus its
    image-installed package, with no second copy of the 1.4 GB default dependency tree.
    """
    manifest_path = variant_dir / "variant.json"
    package_path = profile_dir / "package.json"
    try:
        manifest = json.loads(manifest_path.read_text("utf-8"))
        package = json.loads(package_path.read_text("utf-8"))
    except (OSError, ValueError) as exc:
        raise ServiceError(
            "DSH_PROFILE_VARIANT_INVALID",
            f"cannot read the profile variant manifest or package.json: {exc}",
        )

    dependencies = manifest.get("dependencies") or {}
    if not isinstance(dependencies, dict):
        raise ServiceError(
            "DSH_PROFILE_VARIANT_INVALID",
            f"{manifest_path}: dependencies must be an object",
        )
    if dependencies:
        package.setdefault("dependencies", {}).update(dependencies)

    profile_section = package.setdefault("dsh", {}).setdefault("profile", {})
    bundles = profile_section.get("bundles")
    if not isinstance(bundles, list):
        raise ServiceError(
            "DSH_PROFILE_VARIANT_INVALID",
            f"{package_path}: dsh.profile.bundles must be a list",
        )
    for name in manifest.get("bundles") or []:
        if name not in bundles:
            bundles.append(name)
    package_path.write_text(json.dumps(package, ensure_ascii=False, indent=2) + "\n", "utf-8")

    for entry in manifest.get("linkPackages") or []:
        name = entry.get("name") if isinstance(entry, dict) else None
        source = entry.get("path") if isinstance(entry, dict) else None
        if not name or not source:
            raise ServiceError(
                "DSH_PROFILE_VARIANT_INVALID",
                f"{manifest_path}: every linkPackages entry needs name and path",
            )
        source_path = pathlib.Path(source)
        if not source_path.is_dir():
            raise ServiceError(
                "DSH_PROFILE_VARIANT_PACKAGE_MISSING",
                f"variant package is missing from the image: {source}",
            )
        target = profile_dir / "node_modules" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.is_symlink() or target.exists():
            if target.resolve() == source_path.resolve():
                continue
            raise ServiceError(
                "DSH_PROFILE_VARIANT_CONFLICT",
                f"variant package {name} already exists in the profile from another source",
            )
        target.symlink_to(source_path)

    patch_path = variant_dir / "cordis.patch.yml"
    if patch_path.is_file():
        fragment = patch_path.read_text("utf-8")
        # A comments-only fragment is documentation, not YAML: appending it would produce a
        # second document and DSH would refuse the profile. Detect real rows first.
        has_rows = any(
            line.strip() and not line.strip().startswith("#")
            for line in fragment.splitlines()
        )
        if has_rows:
            with (profile_dir / "cordis.patch.yml").open("a", encoding="utf-8") as handle:
                handle.write("\n" + fragment.strip() + "\n")


def profile_source_dir():
    """Profile source whose marker decides whether the volume copy is current.

    The variant carries its own marker (it hashes the variant declaration and the installed
    package manifest), so switching a workspace onto the variant or bumping the pinned plugin
    re-assembles the profile instead of reusing a tree that lacks the new bundle rows.
    """
    return PROFILE_VARIANT_DIR or DSH_PROFILE_TEMPLATE


def prune_profile_backups():
    """Remove legacy whole-profile copies; keep the active tree and N newest valid backups."""
    profiles_dir = PROFILE_DIR.parent
    if not profiles_dir.is_dir():
        return
    prefixes = (PROFILE_DIR.name + ".", PROFILE_DIR.name + "-")
    valid: list[pathlib.Path] = []
    for child in profiles_dir.iterdir():
        if child.name == PROFILE_DIR.name or not child.name.startswith(prefixes):
            continue
        if child.is_symlink() or not child.is_dir():
            continue
        # A broken or incomplete copy is never a rollback target; drop it regardless of age.
        if ".broken" in child.name or not (child / "package.json").is_file():
            shutil.rmtree(child, ignore_errors=True)
            log_message("pruned invalid profile backup " + child.name)
            continue
        valid.append(child)
    valid.sort(key=lambda item: item.stat().st_mtime, reverse=True)
    for old in valid[PROFILE_BACKUP_KEEP:]:
        shutil.rmtree(old, ignore_errors=True)
        log_message("pruned old profile backup " + old.name)


def prepare_profile():
    # Legacy images left whole-profile copies in this directory; clean them on every start.
    prune_profile_backups()
    # Refresh image-owned dependencies while retaining the Settings editor's user patch.
    expected_source_ref = profile_source_marker(profile_source_dir())
    if PROFILE_DIR.is_dir() and profile_source_marker(PROFILE_DIR) == expected_source_ref:
        return
    profiles_dir = PROFILE_DIR.parent
    profiles_dir.mkdir(parents=True, exist_ok=True)
    staging = profiles_dir / f".{DSH_PROFILE}.dataops-{os.getpid()}"
    if staging.exists():
        shutil.rmtree(staging)
    # `profiles/` holds the variants themselves; copying it into the runtime profile would
    # nest every variant inside every workspace profile.
    shutil.copytree(
        DSH_PROFILE_TEMPLATE,
        staging,
        symlinks=True,
        ignore=shutil.ignore_patterns("profiles"),
    )
    if PROFILE_VARIANT_DIR is not None:
        apply_profile_variant(staging, PROFILE_VARIANT_DIR)
    user_patch = PROFILE_DIR / "cordis.patch.yml"
    if user_patch.is_file():
        shutil.copy2(user_patch, staging / user_patch.name)
    shutil.copy2(profile_source_dir() / PROFILE_SOURCE_MARKER, staging / PROFILE_SOURCE_MARKER)
    if PROFILE_DIR.exists():
        shutil.rmtree(PROFILE_DIR)
    os.replace(staging, PROFILE_DIR)


def log_message(message):
    """Append one lifecycle line to the web log the deployment already reads."""
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    with LOG_PATH.open("ab", buffering=0) as log_file:
        log_file.write((f"[dataops-dsh-service] {message}\n").encode("utf-8"))
    try:
        os.chmod(LOG_PATH, 0o644)
    except OSError:
        pass


def remove_obsolete_managed_skills():
    """Drop retired managed-skill packages from the profile and the DSH home.

    ``prepare_profile()`` replaces the whole profile directory when the template marker
    changes, so an image-owned package disappears on an image update. It does not cover the
    other two states: a skill a previous image copied into ``$DSH_HOME/skills`` (outside the
    profile) and a user patch row that still mounts the removed package -- ``prepare_profile()``
    deliberately keeps ``cordis.patch.yml`` byte-for-byte, so a stale row would fail activation
    forever. The cleanup program owns both and is idempotent.

    A missing script or a failed run is logged and retried on the next start: this is
    hygiene for state the profile replacement cannot reach, not a boot prerequisite.
    """
    script = MANAGED_SKILL_CLEANUP_SCRIPT
    if not script.is_file():
        log_message(f"managed skill cleanup skipped: {script} is missing")
        return
    command = [
        shutil.which("node") or "node",
        str(script),
        "--profile",
        str(PROFILE_DIR),
        "--skills",
        str(DSH_HOME / "skills"),
    ]
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        log_message(f"managed skill cleanup failed to run: {exc}")
        return
    output = (result.stdout or "") + (result.stderr or "")
    if output.strip():
        log_message("managed skill cleanup:\n" + output.strip())
    if result.returncode != 0:
        log_message(f"managed skill cleanup exited with {result.returncode}; will retry on the next start")


# 容器默认模型：先选部署自带的本地模型，托管模型只做显式回退。
#
# 4e97 的 profile 里配置了 `dataops-local-qwen`（vLLM :30099，Qwen3.6-35B-A3B，带视觉塔）。
# provider 存在、模型在 models 列表里、且 `/v1/models` 可达时，默认选它；否则退回
# `dataops-managed` 托管基线。托管模型仍保留在 provider 里，用户可以在模型选择器里显式
# 切回，seed 不会覆盖一个已经能路由的选择。
#
# 为什么不是一个 overlay patch 行：
#   `dataops-dsh-embedded.patch.yml` 用 --patch 传入，任何在它里面出现的 `- id:` 都会把该行
#   钉死（config-editor/src/index.ts:140 会以「overridden by a home patch or command-line
#   overlay」拒绝 Settings 编辑器的写入）。模型选择器必须保持可写，所以默认模型只能落成
#   profile 里的用户设置，不能落成 overlay 里的一行。
#
# 为什么是一个「只在缺失/不可路由时写入」的 seed：
#   用户在模型选择器里改了模型，就以用户的选择为准；这里只负责把「从没配过」或
#   「还指向旧模板 dashscope」的工作区初始化成当前部署可路由的模型。
SEED_DEFAULT_MODEL_PROVIDER = "dataops-managed"
SEED_DEFAULT_MODEL_ID = "deepseek-v4.1-flash-1017"
SEED_DEFAULT_MODEL_EFFORT = "max"
SEED_PREFERRED_MODEL_PROVIDER = "dataops-local-qwen"
SEED_PREFERRED_MODEL_ID = "Qwen3.6-35B-A3B"
SEED_PREFERRED_MODEL_EFFORT = "high"
SEED_LEGACY_MODEL_PROVIDER = "dashscope"
# 部署自己的本地端点曾经/现在长这样：旧的 llama.cpp :19110（Qwen3.8-27B-DavidAU-Q8）和
# 现在的 vLLM :30099（Qwen3.6-35B-A3B）。只有这两个端点上的 provider 块算「部署基线」，
# 可以被模板整体刷新；用户自己改到别的 host 的 provider 不动。
SEED_LOCAL_ENDPOINT_PORTS = (":19110", ":30099")
SEED_LEGACY_LOCAL_MODEL_IDS = ("Qwen3.8-27B-DavidAU-Q8",)
# 模板曾经写过的默认值。它们不是用户选择，seed 可以在本地模型健康时升级掉。
SEED_BASELINE_SELECTIONS = {
    (SEED_DEFAULT_MODEL_PROVIDER, SEED_DEFAULT_MODEL_ID),
    (SEED_LEGACY_MODEL_PROVIDER, SEED_DEFAULT_MODEL_ID),
    (SEED_PREFERRED_MODEL_PROVIDER, SEED_LEGACY_LOCAL_MODEL_IDS[0]),
}
SEED_MODEL_ROW_ID = "agent-default-model"
SEED_LLM_ROW_ID = "llm-pi-ai"
SEED_MARKER = "# Container default model"
SEED_AUTO_SELECTION_MARKER = "model-default-auto.json"
# provider 级图片上限（不是 model 级）：llm-pi-ai 的 config.ts 把这四个字段定义在
# provider 上。模板与运行时 profile 必须同值，`align_local_provider()` 会校验。
LOCAL_PROVIDER_IMAGE_LIMITS = {
    "maxRequestImageBytes": 67108864,
    "maxRequestImages": 8,
    "requestImagePixelBudget": 16777216,
    "requestImageMaxBytes": 16777216,
}

# 工作区默认外观：深色，分两层落。两个都必要，缺一个就会看到浅色：
#
# 1. profile 的 `cordis.patch.yml` 里一行 `- id: ui-theme config.preference: dark`，决定
#    服务端首次渲染的预涂（bootThemeInjections 在 index-inject 时读的就是它）；
# 2. `$DSH_HOME/settings.yaml` 的 `ui-theme.preference`，由 DSH 启动时导入 settings 服务
#    （importLegacyDocument：读完 rename 成 settings.yaml.imported），客户端的主题 store
#    随后用这份 settings 快照覆盖预涂。没有它，客户端会退回 schema 默认 `system`，
#    浏览器实测 data-ds-theme-source=system、白底。
#
# 这个部署没有持久 settings provider，导入只进内存，所以 settings.yaml 每次启动都要重建：
# 「容器默认深色，用户在外观设置里的选择不跨重启保留」。要改默认值就改这里。
SEED_THEME_ROW_ID = "ui-theme"
SEED_THEME_ROW_NAME = "@deepseek-ai/dsh-client-ui-theme"
SEED_THEME_PREFERENCE = "dark"
SEED_THEME_MARKER = "# Container default appearance"


def seed_default_theme():
    """Seed the appearance into both layers the browser reads, without pinning either.

    Layer one is the profile patch's `ui-theme` row, which the host reads when it injects the
    boot theme into the served page. A profile that already states a preference -- the user's
    choice or an earlier seed -- is left untouched.

    Layer two is the settings document, written by `seed_theme_settings()`; the row alone only
    pre-paints the first frame, and the client store replaces it with the settings snapshot.

    `prepare_profile()` retains the profile patch across an image refresh, and both seeds run on
    every start, so a volume created later receives them too.
    """
    try:
        import yaml
    except ImportError:
        return
    patch_path = PROFILE_DIR / "cordis.patch.yml"
    try:
        text = patch_path.read_text("utf-8")
    except FileNotFoundError:
        text = ""
    except OSError:
        return
    document = _parse_profile_patch(text) or []
    if not isinstance(document, list) or not all(isinstance(row, dict) for row in document):
        return

    theme_rows = [row for row in document if row.get("id") == SEED_THEME_ROW_ID and "insert" not in row]
    for row in theme_rows:
        config = row.get("config")
        if isinstance(config, dict) and config.get("preference") is not None:
            return

    if theme_rows:
        updated = _add_theme_preference(text)
        if updated is None:
            return
    else:
        if text != "" and not text.endswith("\n"):
            text = text + "\n"
        updated = text + (
            f"{SEED_THEME_MARKER}\n"
            f"- id: {SEED_THEME_ROW_ID}\n"
            f'  name: "{SEED_THEME_ROW_NAME}"\n'
            f"  config:\n"
            f"    preference: {SEED_THEME_PREFERENCE}\n"
        )

    # The rewrite must still parse and must still carry the value it promises.
    try:
        written = yaml.safe_load(updated) or []
    except yaml.YAMLError:
        return
    if not isinstance(written, list):
        return
    carries = any(
        isinstance(row, dict)
        and row.get("id") == SEED_THEME_ROW_ID
        and isinstance(row.get("config"), dict)
        and row["config"].get("preference") == SEED_THEME_PREFERENCE
        for row in written
    )
    if not carries:
        return
    patch_path.parent.mkdir(parents=True, exist_ok=True)
    staged = patch_path.with_name(patch_path.name + ".dataops-seed")
    staged.write_text(updated if updated.endswith("\n") else updated + "\n", "utf-8")
    os.chmod(staged, 0o600)
    os.replace(staged, patch_path)


def _add_theme_preference(text):
    """Insert `preference` under an existing `ui-theme` row that states none.

    Textual for the same reason as the model seed: a `yaml.safe_load` round-trip rewrites the
    whole user document and drops its comments. The caller validates the result by parsing it.
    """
    lines = text.split("\n")
    row_at = None
    for index, line in enumerate(lines):
        if line.strip() == f"- id: {SEED_THEME_ROW_ID}":
            row_at = index
            break
    if row_at is None:
        return None
    row_indent = len(lines[row_at]) - len(lines[row_at].lstrip())
    config_at = None
    for index in range(row_at + 1, len(lines)):
        stripped = lines[index].strip()
        if stripped == "" or stripped.startswith("#"):
            continue
        if len(lines[index]) - len(lines[index].lstrip()) <= row_indent:
            break
        if stripped == "config:":
            config_at = index
            break
    if config_at is None:
        return None
    field_indent = " " * ((len(lines[config_at]) - len(lines[config_at].lstrip())) + 2)
    lines.insert(config_at + 1, f"{field_indent}preference: {SEED_THEME_PREFERENCE}")
    return "\n".join(lines)


def seed_theme_settings():
    """Write the settings document DSH imports at boot, in the shape the settings service reads.

    `@deepseek-ai/dsh-settings` reads `<DSH_HOME>/settings.yaml` once the loader settles, renames
    it to `settings.yaml.imported`, and applies each section to the plugin entry that owns that
    name. Without a persisted settings provider the values live only in memory, so the document is
    rewritten on every start: the container default is dark, and a choice made in the Appearance
    row does not survive a restart.

    The profile patch row is not enough on its own. It pre-paints the first frame (the host reads
    it for the boot theme), but the client theme store is fed from the settings snapshot and
    falls back to the schema default `system` when no section exists -- measured in a browser as
    `data-ds-theme-source=system` on a white page while the served HTML already said dark.

    Idempotent and non-destructive: a document that already states a preference is left as it
    is, and every other section it carries is preserved. The rename DSH performs overwrites an
    older `settings.yaml.imported`, which is why this never tries to create that file.
    """
    try:
        import yaml
    except ImportError:
        return
    path = DSH_HOME / "settings.yaml"
    document = {}
    if path.is_file():
        try:
            loaded = yaml.safe_load(path.read_text("utf-8")) or {}
        except (OSError, yaml.YAMLError):
            return
        if not isinstance(loaded, dict):
            return
        document = loaded
        section = document.get(SEED_THEME_ROW_ID)
        if isinstance(section, dict) and section.get("preference") is not None:
            return
    section = document.get(SEED_THEME_ROW_ID)
    if not isinstance(section, dict):
        section = {}
    section["preference"] = SEED_THEME_PREFERENCE
    document[SEED_THEME_ROW_ID] = section
    text = yaml.safe_dump(document, sort_keys=True, allow_unicode=True)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        staged = path.with_name(path.name + ".dataops-seed")
        staged.write_text(text, "utf-8")
        os.chmod(staged, 0o600)
        os.replace(staged, path)
    except OSError:
        return


def _parse_profile_patch(text):
    """Parse a profile patch without tripping over DSH's ``!!js`` scalar tags.

    The profile uses ``!!js dshHomePath(...)`` for paths. PyYAML's safe loader has no
    constructor for that application tag, and the old code treated the whole file as
    unparseable, which silently disabled both the model seed and this migration.
    Strip only the tag marker for inspection; the original text is what gets written.
    """
    try:
        import yaml
    except ImportError:
        return None
    try:
        return yaml.safe_load(text.replace("!!js ", ""))
    except yaml.YAMLError:
        return None


def _provider_models(provider):
    """Return a provider's model entries as a list, tolerating a malformed block."""
    if not isinstance(provider, dict):
        return []
    models = provider.get("models")
    return models if isinstance(models, list) else []


def _provider_serves_model(provider, model_id):
    """Whether this provider block advertises the requested model id."""
    return any(
        isinstance(model, dict) and model.get("id") == model_id
        for model in _provider_models(provider)
    )


def _template_provider_block(provider_id):
    """Copy one provider block out of the image profile template, verbatim.

    The template is the single source of truth for the self-hosted provider (model id,
    non-secret baseURL, placeholder header). Reading the block instead of restating it
    here keeps a deployment's endpoint and model overrides from drifting between the
    two copies.
    """
    try:
        text = (DSH_PROFILE_TEMPLATE / "cordis.patch.yml").read_text("utf-8")
    except OSError:
        return None
    lines = text.splitlines(keepends=True)
    start = None
    marker = f"      {provider_id}:"
    for index, line in enumerate(lines):
        if line.rstrip("\n") == marker:
            start = index
            break
    if start is None:
        return None
    end = len(lines)
    for index in range(start + 1, len(lines)):
        line = lines[index]
        if line.startswith("- "):
            end = index
            break
        # A sibling provider key sits at exactly six spaces of indentation; every
        # provider property is indented deeper.
        if line.startswith("      ") and not line.startswith("       ") and line.strip():
            end = index
            break
    block = "".join(lines[start:end])
    return block if block.endswith("\n") else block + "\n"


def seed_local_provider():
    """Add the template's self-hosted provider to a profile that predates it.

    A profile created from an older template keeps its `cordis.patch.yml`
    byte-for-byte across image refreshes, so a provider added to the template never
    reaches it. Without this provider a new workspace's default-model seed sees no
    healthy local candidate and falls back to the cloud DashScope baseline, which has
    no key in this deployment (`MISSING_CREDENTIAL: dashscope`). Adding only a
    missing provider is idempotent and never touches rows the user owns.
    """
    patch_path = PROFILE_DIR / "cordis.patch.yml"
    try:
        text = patch_path.read_text("utf-8")
    except OSError:
        return
    if f"      {SEED_PREFERRED_MODEL_PROVIDER}:" in text:
        return
    block = _template_provider_block(SEED_PREFERRED_MODEL_PROVIDER)
    if block is None:
        log_message(
            f"local provider seed skipped: template has no {SEED_PREFERRED_MODEL_PROVIDER} block"
        )
        return

    lines = text.splitlines(keepends=True)
    llm_start = None
    insert_at = None
    for index, line in enumerate(lines):
        if line.rstrip("\n") == f"- id: {SEED_LLM_ROW_ID}":
            llm_start = index
            continue
        if llm_start is not None and line.startswith("- "):
            insert_at = index
            break
    if llm_start is None or insert_at is None:
        log_message("local provider seed skipped: profile has no llm-pi-ai row")
        return

    updated = "".join(lines[:insert_at]) + block + "".join(lines[insert_at:])
    document = _parse_profile_patch(updated) or []
    llm_row = next(
        (row for row in document if isinstance(row, dict) and row.get("id") == SEED_LLM_ROW_ID),
        None,
    )
    config = llm_row.get("config") if isinstance(llm_row, dict) else None
    providers = config.get("providers") if isinstance(config, dict) else None
    provider = providers.get(SEED_PREFERRED_MODEL_PROVIDER) if isinstance(providers, dict) else None
    if not _provider_serves_model(provider, SEED_PREFERRED_MODEL_ID):
        log_message("local provider seed skipped: merged profile did not validate")
        return

    staged = patch_path.with_name(patch_path.name + ".dataops-provider")
    try:
        staged.write_text(updated, "utf-8")
        os.chmod(staged, 0o600)
        os.replace(staged, patch_path)
    except OSError:
        return
    log_message(f"local provider seeded: {SEED_PREFERRED_MODEL_PROVIDER} / {SEED_PREFERRED_MODEL_ID}")


def _provider_block_config(block, provider_id):
    """Parse one six-space-indented provider block into its config mapping."""
    document = _parse_profile_patch(
        "- id: dataops-provider-probe\n"
        "  config:\n"
        "    providers:\n" + block
    )
    if not isinstance(document, list) or not document or not isinstance(document[0], dict):
        return None
    config = document[0].get("config")
    providers = config.get("providers") if isinstance(config, dict) else None
    provider = providers.get(provider_id) if isinstance(providers, dict) else None
    return provider if isinstance(provider, dict) else None


def _profile_provider_config(patch_text, provider_id):
    """Return one profile's provider config, or None when the row is absent."""
    document = _parse_profile_patch(patch_text) or []
    if not isinstance(document, list):
        return None
    for row in document:
        if not isinstance(row, dict) or row.get("id") != SEED_LLM_ROW_ID:
            continue
        config = row.get("config")
        providers = config.get("providers") if isinstance(config, dict) else None
        provider = providers.get(provider_id) if isinstance(providers, dict) else None
        return provider if isinstance(provider, dict) else None
    return None


def _is_deployment_local_provider(provider):
    """Whether this provider block sits on one of the deployment's own local endpoints."""
    base_url = provider.get("baseURL") if isinstance(provider, dict) else None
    if not isinstance(base_url, str):
        return False
    endpoint = base_url.strip()
    if not (
        endpoint.startswith("http://host.docker.internal:")
        or endpoint.startswith("http://127.0.0.1:")
    ):
        return False
    return any(port in endpoint for port in SEED_LOCAL_ENDPOINT_PORTS)


def _local_provider_needs_alignment(provider, expected):
    """Whether a deployment-owned provider block lacks the template's current capability."""
    if not isinstance(provider, dict) or not isinstance(expected, dict):
        return True
    if provider.get("baseURL") != expected.get("baseURL"):
        return True
    if not _provider_serves_model(provider, SEED_PREFERRED_MODEL_ID):
        return True
    model = next(
        (
            entry
            for entry in _provider_models(provider)
            if isinstance(entry, dict) and entry.get("id") == SEED_PREFERRED_MODEL_ID
        ),
        None,
    )
    modalities = model.get("input") if isinstance(model, dict) else None
    if not isinstance(modalities, list) or "image" not in modalities:
        return True
    return any(provider.get(field) != value for field, value in LOCAL_PROVIDER_IMAGE_LIMITS.items())


def _replace_provider_block(patch_text, provider_id, block):
    """Replace one provider block in place, keeping every other byte of the profile."""
    lines = patch_text.splitlines(keepends=True)
    marker = f"      {provider_id}:"
    start = None
    for index, line in enumerate(lines):
        if line.rstrip("\n") == marker:
            start = index
            break
    if start is None:
        return None
    end = len(lines)
    for index in range(start + 1, len(lines)):
        line = lines[index]
        if line.startswith("- "):
            end = index
            break
        # A sibling provider key sits at exactly six spaces of indentation; every
        # provider property is indented deeper.
        if line.startswith("      ") and not line.startswith("       ") and line.strip():
            end = index
            break
    # Drop the stale deployment comment block above the old provider so the next reader
    # does not see the replaced endpoint/model described as current.
    while start > 0:
        previous = lines[start - 1]
        if not previous.strip().startswith("#"):
            break
        if (
            "19110" in previous
            or "30099" in previous
            or "Qwen3." in previous
            or "llama.cpp" in previous
            or "vLLM" in previous
        ):
            start -= 1
            continue
        break
    head = "".join(lines[:start])
    if head and not head.endswith("\n"):
        head += "\n"
    return head + block + "".join(lines[end:])


def _backup_profile(patch_path):
    """Copy the profile patch aside before a deployment-owned rewrite."""
    stamp = datetime.datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    destination = DSH_HOME / "backups" / f"{patch_path.name}.{stamp}.bak"
    try:
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(patch_path, destination)
        os.chmod(destination, 0o600)
    except OSError:
        return None
    log_message(f"profile backed up before rewrite: {destination}")
    return destination


def align_local_provider():
    """Refresh a deployment-owned local provider block to the template's current capability.

    ``prepare_profile()`` keeps the user patch byte-for-byte across image updates and
    ``seed_local_provider()`` only adds a provider that is entirely absent, so a profile
    created in the Qwen3.8/llama.cpp era keeps a text-only provider forever: the model
    picker lists a model that rejects every image attachment with
    ``UNSUPPORTED_CONTENT: pi-ai model ... does not support image input``. This rewrites
    the block from the template when it is one of the deployment's own endpoints, which
    is where the model id, endpoint, input modalities, and image budgets live.

    Idempotent: an aligned block returns before touching the file. A provider pointed at
    any other host is left alone, and the profile is copied aside before each rewrite.
    """
    patch_path = PROFILE_DIR / "cordis.patch.yml"
    try:
        text = patch_path.read_text("utf-8")
    except OSError:
        return
    block = _template_provider_block(SEED_PREFERRED_MODEL_PROVIDER)
    if block is None:
        log_message(
            f"local provider alignment skipped: template has no {SEED_PREFERRED_MODEL_PROVIDER} block"
        )
        return
    expected = _provider_block_config(block, SEED_PREFERRED_MODEL_PROVIDER)
    if expected is None:
        log_message("local provider alignment skipped: template block did not parse")
        return
    current = _profile_provider_config(text, SEED_PREFERRED_MODEL_PROVIDER)
    if current is None:
        return
    if not _is_deployment_local_provider(current):
        log_message("local provider alignment skipped: profile points at a non-deployment endpoint")
        return
    if not _local_provider_needs_alignment(current, expected):
        return
    updated = _replace_provider_block(text, SEED_PREFERRED_MODEL_PROVIDER, block)
    if updated is None:
        log_message("local provider alignment skipped: provider block could not be replaced")
        return
    aligned = _profile_provider_config(updated, SEED_PREFERRED_MODEL_PROVIDER)
    if _local_provider_needs_alignment(aligned, expected):
        log_message("local provider alignment skipped: rewritten profile did not match the template")
        return
    if _backup_profile(patch_path) is None:
        log_message("local provider alignment skipped: profile backup failed")
        return
    staged = patch_path.with_name(patch_path.name + ".dataops-provider-align")
    try:
        staged.write_text(updated, "utf-8")
        os.chmod(staged, 0o600)
        os.replace(staged, patch_path)
    except OSError:
        return
    log_message(
        "local provider aligned: "
        f"{SEED_PREFERRED_MODEL_PROVIDER} / {SEED_PREFERRED_MODEL_ID} (image input, "
        f"{LOCAL_PROVIDER_IMAGE_LIMITS['maxRequestImageBytes']}B request cap, "
        f"{LOCAL_PROVIDER_IMAGE_LIMITS['maxRequestImages']} images)"
    )


def _provider_healthy(provider, model_id, timeout=2.5):
    """Probe a provider's ``/models`` endpoint and require the model id in the reply.

    Only the preferred local provider is probed. A short timeout keeps a cold or
    unreachable llama.cpp process from delaying DSH start; any failure means "not
    preferred", which lets the managed provider become the fallback.
    """
    base_url = provider.get("baseURL") if isinstance(provider, dict) else None
    if not isinstance(base_url, str) or not base_url.strip():
        return False
    request = urllib.request.Request(base_url.rstrip("/") + "/models")
    headers = provider.get("headers")
    if isinstance(headers, dict):
        for key, value in headers.items():
            if isinstance(key, str) and isinstance(value, str):
                request.add_header(key, value)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read(1024 * 1024).decode("utf-8"))
    except Exception:
        return False
    data = payload.get("data") if isinstance(payload, dict) else None
    return isinstance(data, list) and any(
        isinstance(item, dict) and item.get("id") == model_id for item in data
    )


def _read_auto_selection():
    """Read the provider/model tuple this seed wrote last, when it still applies."""
    try:
        payload = json.loads((RUNTIME_DIR / SEED_AUTO_SELECTION_MARKER).read_text("utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(payload, dict):
        return None
    provider = payload.get("provider")
    model = payload.get("model")
    if not isinstance(provider, str) or not isinstance(model, str):
        return None
    return provider, model


def _write_auto_selection(provider, model):
    """Record an automatic selection so a later start can upgrade it, not a user's choice."""
    marker_path = RUNTIME_DIR / SEED_AUTO_SELECTION_MARKER
    try:
        marker_path.parent.mkdir(parents=True, exist_ok=True)
        staged = marker_path.with_name(marker_path.name + ".dataops-seed")
        staged.write_text(
            json.dumps({"provider": provider, "model": model}, ensure_ascii=False) + "\n",
            "utf-8",
        )
        os.chmod(staged, 0o600)
        os.replace(staged, marker_path)
    except OSError:
        return


def _seed_candidates(providers):
    """Ordered default-model candidates for this profile.

    The local model is preferred only when its provider advertises the model and the
    endpoint answers; the managed provider is the explicit fallback. The legacy
    ``dashscope`` name is last so an old profile that actually configures it still
    receives a routable default.
    """
    candidates = []
    if not isinstance(providers, dict):
        return candidates
    local = providers.get(SEED_PREFERRED_MODEL_PROVIDER)
    if _provider_serves_model(local, SEED_PREFERRED_MODEL_ID) and _provider_healthy(
        local, SEED_PREFERRED_MODEL_ID
    ):
        candidates.append(
            (SEED_PREFERRED_MODEL_PROVIDER, SEED_PREFERRED_MODEL_ID, SEED_PREFERRED_MODEL_EFFORT)
        )
    managed = providers.get(SEED_DEFAULT_MODEL_PROVIDER)
    if _provider_serves_model(managed, SEED_DEFAULT_MODEL_ID):
        candidates.append((SEED_DEFAULT_MODEL_PROVIDER, SEED_DEFAULT_MODEL_ID, SEED_DEFAULT_MODEL_EFFORT))
    legacy = providers.get(SEED_LEGACY_MODEL_PROVIDER)
    if _provider_serves_model(legacy, SEED_DEFAULT_MODEL_ID):
        candidates.append((SEED_LEGACY_MODEL_PROVIDER, SEED_DEFAULT_MODEL_ID, SEED_DEFAULT_MODEL_EFFORT))
    return candidates


LEGACY_DEFAULT_MODEL_SELECTIONS = {
    ("tokensfree_ds", "deepseek-v4.1-flash"),
    ("dashscope", "deepseek-v4.1-flash-1017"),
}
MODEL_DEFAULT_MIGRATION_MARKER = "model-default-migration.json"


def migrate_legacy_default_model():
    """Move the known-bad container seed to the supported baseline exactly once.

    ``seed_default_model`` deliberately never overwrites an existing selection, so a
    workspace that was first booted with the old TokensFree seed keeps that broken row
    forever. This migration covers only the known legacy pair and records a marker:
    once it has run, a later TokensFree choice is the user's ``lastSelected`` and is
    left alone by every subsequent start.
    """
    marker_path = RUNTIME_DIR / MODEL_DEFAULT_MIGRATION_MARKER
    if marker_path.exists():
        return
    try:
        import yaml
    except ImportError:
        return
    patch_path = PROFILE_DIR / "cordis.patch.yml"
    try:
        text = patch_path.read_text("utf-8")
    except OSError:
        return
    document = _parse_profile_patch(text) or []
    if not isinstance(document, list):
        return
    default_row = next(
        (row for row in document if isinstance(row, dict) and row.get("id") == SEED_MODEL_ROW_ID),
        None,
    )
    config = default_row.get("config") if isinstance(default_row, dict) else None
    if not isinstance(config, dict):
        return
    if (str(config.get("provider") or ""), str(config.get("model") or "")) not in LEGACY_DEFAULT_MODEL_SELECTIONS:
        return

    # Only migrate when the target provider and model are actually configured here.
    llm_row = next(
        (row for row in document if isinstance(row, dict) and row.get("id") == SEED_LLM_ROW_ID),
        None,
    )
    llm_config = llm_row.get("config") if isinstance(llm_row, dict) else None
    providers = llm_config.get("providers") if isinstance(llm_config, dict) else None
    provider = providers.get(SEED_DEFAULT_MODEL_PROVIDER) if isinstance(providers, dict) else None
    models = provider.get("models") if isinstance(provider, dict) else None
    if not isinstance(models, list) or not any(
        isinstance(model, dict) and model.get("id") == SEED_DEFAULT_MODEL_ID for model in models
    ):
        return

    updated = _rewrite_default_model_selection(
        text,
        SEED_DEFAULT_MODEL_PROVIDER,
        SEED_DEFAULT_MODEL_ID,
        SEED_DEFAULT_MODEL_EFFORT,
    )
    if updated is None:
        return
    written = _parse_profile_patch(updated) or []
    if not isinstance(written, list):
        return
    written_row = next(
        (row for row in written if isinstance(row, dict) and row.get("id") == SEED_MODEL_ROW_ID),
        None,
    )
    written_config = written_row.get("config") if isinstance(written_row, dict) else None
    if not isinstance(written_config, dict):
        return
    if (
        written_config.get("provider") != SEED_DEFAULT_MODEL_PROVIDER
        or written_config.get("model") != SEED_DEFAULT_MODEL_ID
    ):
        return
    patch_path.write_text(updated if updated.endswith("\n") else updated + "\n", "utf-8")
    os.chmod(patch_path, 0o600)
    marker_path.write_text(
        json.dumps(
            {
                "from": {"provider": "tokensfree_ds", "model": "deepseek-v4.1-flash"},
                "to": {
                    "provider": SEED_DEFAULT_MODEL_PROVIDER,
                    "model": SEED_DEFAULT_MODEL_ID,
                    "reasoningEffort": SEED_DEFAULT_MODEL_EFFORT,
                },
                "reason": "legacy container seed could not route to an upstream model",
                "migratedAt": datetime.datetime.now(timezone.utc).isoformat(),
            },
            ensure_ascii=False,
        )
        + "\n",
        "utf-8",
    )
    os.chmod(marker_path, 0o600)
    # The seed's own marker still names the pair this migration just replaced. Without
    # updating it, seed_default_model() reads a current selection that no longer matches
    # the marker, stops treating it as automatic, and never upgrades it to the local
    # model even when that provider is healthy.
    _write_auto_selection(SEED_DEFAULT_MODEL_PROVIDER, SEED_DEFAULT_MODEL_ID)


def repair_migrated_auto_selection():
    """Move a stale auto marker onto the pair a previous migration wrote.

    A workspace that ran the legacy migration before this repair still carries
    ``model-default-auto.json = dashscope/...`` while its profile already names
    ``dataops-managed/...``. ``seed_default_model`` compares the marker with the
    current pair, no longer recognizes the selection as automatic, and leaves it
    there instead of upgrading to the healthy local provider.
    """
    auto = _read_auto_selection()
    if auto is None or auto[0] != SEED_LEGACY_MODEL_PROVIDER:
        return
    try:
        text = (PROFILE_DIR / "cordis.patch.yml").read_text("utf-8")
    except OSError:
        return
    document = _parse_profile_patch(text) or []
    if not isinstance(document, list):
        return
    default_row = next(
        (row for row in document if isinstance(row, dict) and row.get("id") == SEED_MODEL_ROW_ID),
        None,
    )
    config = default_row.get("config") if isinstance(default_row, dict) else None
    if not isinstance(config, dict):
        return
    current_pair = (str(config.get("provider") or ""), str(config.get("model") or ""))
    if current_pair == (SEED_DEFAULT_MODEL_PROVIDER, SEED_DEFAULT_MODEL_ID):
        _write_auto_selection(*current_pair)


def _rewrite_default_model_selection(text, provider, model, effort):
    """Rewrite provider/model/reasoningEffort inside the existing default row."""
    lines = text.splitlines()
    start = None
    base_indent = 0
    for index, line in enumerate(lines):
        stripped = line.strip()
        if stripped == f"- id: {SEED_MODEL_ROW_ID}":
            start = index
            base_indent = len(line) - len(line.lstrip())
            break
    if start is None:
        return None
    end = len(lines)
    for index in range(start + 1, len(lines)):
        stripped = lines[index].strip()
        if stripped and not lines[index].startswith(" " * (base_indent + 1)):
            end = index
            break
    block = lines[start:end]
    found = {"provider": False, "model": False, "reasoningEffort": False}
    for index, line in enumerate(block):
        stripped = line.strip()
        key = stripped.split(":", 1)[0] if ":" in stripped else ""
        if key not in found:
            continue
        indent = line[: len(line) - len(line.lstrip())]
        block[index] = f"{indent}{key}: {provider if key == 'provider' else model if key == 'model' else effort}"
        found[key] = True
    if not all(found.values()):
        # The seed writes all three fields; refuse to synthesize a partial row.
        return None
    rewritten = lines[:start] + block + lines[end:]
    return "\n".join(rewritten) + ("\n" if text.endswith("\n") else "")


def seed_default_model():
    """Point a new profile at the local model, with managed as the explicit fallback.

    Candidate order comes from `_seed_candidates`: the preferred local provider must
    advertise the model and answer its `/models` endpoint; otherwise the managed
    provider is the fallback. A selection that already routes is left untouched, so a
    model chosen in the selector survives restart. A selection this seed wrote earlier
    (tracked by `model-default-auto.json`) and the template's old baseline values are
    upgraded once the local provider becomes healthy.

    Only the profile's own patch is written, never the overlay: a row in
    `dataops-dsh-embedded.patch.yml` arrives through `--patch`, and the config editor
    refuses a Settings write the composed value would shadow
    (config-editor/src/index.ts:140, "overridden by a home patch or command-line
    overlay"). The model selector has to stay writable, so the default belongs here.

    Edits are textual on purpose. A `yaml.safe_load` round-trip reads the bare key
    `off:` in an existing model's `reasoningEfforts` as boolean False and writes it
    back as the string key `'off'`, which the schema rejects -- that silently drops
    the whole provider from the catalog. Only complete, correctly indented blocks are
    appended or substituted, and the file is re-parsed to confirm the result.
    """
    patch_path = PROFILE_DIR / "cordis.patch.yml"
    try:
        import yaml
    except ImportError:
        return
    try:
        text = patch_path.read_text("utf-8")
    except FileNotFoundError:
        text = ""
    except OSError:
        return
    document = _parse_profile_patch(text) or []
    if not isinstance(document, list) or not all(isinstance(row, dict) for row in document):
        return

    def row_with_id(identifier):
        for row in document:
            if row.get("id") == identifier and "insert" not in row:
                return row
        return None

    llm_row = row_with_id(SEED_LLM_ROW_ID)
    llm_config = llm_row.get("config") if isinstance(llm_row, dict) else None
    providers = llm_config.get("providers") if isinstance(llm_config, dict) else None

    default_row = row_with_id(SEED_MODEL_ROW_ID)
    current = default_row.get("config") if isinstance(default_row, dict) else None
    current_pair = (
        (str(current.get("provider") or ""), str(current.get("model") or ""))
        if isinstance(current, dict)
        else ("", "")
    )
    current_provider = providers.get(current_pair[0]) if isinstance(providers, dict) else None
    routes = _provider_serves_model(current_provider, current_pair[1])
    auto_selection = _read_auto_selection()
    is_auto = auto_selection is not None and current_pair == auto_selection
    is_template_baseline = current_pair in SEED_BASELINE_SELECTIONS

    needs_preferred = (
        default_row is None
        or not routes
        or is_auto
        or (auto_selection is None and is_template_baseline)
    )
    if not needs_preferred:
        # Record a valid selection the first time this seed sees it. Without a marker a
        # later explicit switch back to the managed baseline would look like the template's
        # old baseline and be upgraded again; with it, the user's choice is distinguishable.
        if routes and auto_selection is None:
            _write_auto_selection(*current_pair)
        return

    candidates = _seed_candidates(providers)
    if not candidates:
        return
    preferred = candidates[0]

    updated = text
    changed = False
    if default_row is None:
        updated = _append_default_model(updated, *preferred)
        changed = True
    elif not routes:
        # An old template named `dashscope`, which this deployment may not configure.
        # Repair only a selection that cannot route; a valid user choice stays.
        updated = _replace_default_model(updated, *preferred)
        changed = updated is not None and updated != text
    elif is_auto or (auto_selection is None and is_template_baseline):
        # A selection this seed wrote earlier, or the template's old baseline, is not a
        # user's choice: upgrade it when the preferred local model has become healthy.
        if current_pair != (preferred[0], preferred[1]):
            updated = _replace_default_model(updated, *preferred)
            changed = updated is not None and updated != text

    if not changed:
        if routes and auto_selection is None:
            _write_auto_selection(*current_pair)
        return
    # The rewrite must still parse and must still carry the values it promises.
    written = _parse_profile_patch(updated) or []
    if not isinstance(written, list):
        return
    written_row = next(
        (row for row in written if isinstance(row, dict) and row.get("id") == SEED_MODEL_ROW_ID),
        None,
    )
    written_config = written_row.get("config") if isinstance(written_row, dict) else None
    if not isinstance(written_config, dict):
        return
    if (
        written_config.get("provider") != preferred[0]
        or written_config.get("model") != preferred[1]
    ):
        return
    patch_path.write_text(updated if updated.endswith("\n") else updated + "\n", "utf-8")
    os.chmod(patch_path, 0o600)
    _write_auto_selection(preferred[0], preferred[1])
    log_message(f"default model seeded: {preferred[0]} / {preferred[1]}")


def _default_model_block(provider, model, effort):
    """Render the `agent-default-model` row as a complete, correctly indented block."""
    lines = [
        f"- id: {SEED_MODEL_ROW_ID}",
        '  name: "@deepseek-ai/dsh-agent-default-model"',
        "  config:",
        f"    provider: {provider}",
        f"    model: {model}",
    ]
    if effort:
        lines.append(f"    reasoningEffort: {effort}")
    return "\n".join(lines)


def _replace_default_model(text, provider, model, effort):
    """Replace the existing `agent-default-model` block in place, preserving neighbours."""
    lines = text.splitlines()
    start = None
    for index, line in enumerate(lines):
        if line.strip() == f"- id: {SEED_MODEL_ROW_ID}":
            start = index
            break
    if start is None:
        return None
    base_indent = len(lines[start]) - len(lines[start].lstrip())
    end = len(lines)
    for index in range(start + 1, len(lines)):
        stripped = lines[index].strip()
        if stripped and not lines[index].startswith(" " * (base_indent + 1)):
            end = index
            break
    block = _default_model_block(provider, model, effort).splitlines()
    rewritten = lines[:start] + block + lines[end:]
    return "\n".join(rewritten) + ("\n" if text.endswith("\n") else "")


def _append_default_model(text, provider, model, effort):
    if text and not text.endswith("\n"):
        text += "\n"
    if text and SEED_MARKER not in text:
        text += (
            SEED_MARKER + ": local model first, managed model as the explicit fallback.\n"
            "# Written by dataops-dsh-service only where a selection is missing or cannot route;\n"
            "# the model selector stays authoritative afterwards, so a user's choice is never overwritten.\n"
        )
    return text + _default_model_block(provider, model, effort) + "\n"


def read_pid():
    if not PID_PATH.is_file():
        return None
    value = PID_PATH.read_text("utf-8").strip()
    if not value.isdecimal():
        return None
    pid = int(value)
    return pid if pid > 1 else None


# PID 文件跨容器重建持久化，必须同时确认该 PID 仍属于本 DSH entry。
def process_running(pid):
    if pid is None:
        return False
    command_path = pathlib.Path(f"/proc/{pid}/cmdline")
    if not command_path.is_file():
        return False
    try:
        arguments = command_path.read_bytes().split(b"\0")
    except OSError as exc:
        traceback.print_exception(exc, file=sys.stderr)
        return False
    return os.fsencode(str(DSH_ENTRY)) in arguments


def port_open():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as client:
        client.settimeout(0.25)
        return client.connect_ex((DSH_HOST, DSH_PORT)) == 0


# DSH先监听socket再挂载Web路由；仅根页面成功才报告Web ready。
# 开了认证的 DSH 对不带 cookie 的 "/" 返回 401：Web 路由已经挂上，只是这次探测没有凭据，
# 所以 401 同样是 ready —— 否则服务会永远报告未就绪。
def web_ready():
    connection = http.client.HTTPConnection(DSH_HOST, DSH_PORT, timeout=0.5)
    try:
        connection.request("GET", "/", headers={"Connection": "close"})
        response = connection.getresponse()
        response.read(1)
        return 200 <= response.status < 400 or response.status == 401
    except (OSError, http.client.HTTPException):
        return False
    finally:
        connection.close()


def profile_has_plugin(bundle_name):
    """本 profile 的 bundles 是否包含该插件；读不到时按「包含」处理。

    进程已经起来了才调用，此时 profile 必然存在；读失败退回保守值，宁可多等一次，
    也不要在插件确实存在时跳过等待 —— 那会让假就绪回来。
    """
    manifest = PROFILE_DIR / "package.json"
    try:
        document = json.loads(manifest.read_text("utf-8"))
    except (OSError, ValueError):
        return True
    bundles = document.get("dsh", {}).get("profile", {}).get("bundles") or []
    return bundle_name in bundles


# 根页面由静态资源 fallback 提供，插件树还在激活时它已经返回 200。此时 start 会报告
# ready，浏览器随后连上一个还没有插件路由的实例：DataOps 的 JWT 注入路由 404、
# WebSocket 中继断掉，页面停在「重新连接中」，刷新才恢复。
# 因此「端口活 + 根页面通」之外，还要等一个只由插件注册的路由真的存在。
def plugin_ready():
    connection = http.client.HTTPConnection(DSH_HOST, DSH_PORT, timeout=1.0)
    try:
        connection.request("GET", PLUGIN_READY_PATH, headers={"Connection": "close"})
        response = connection.getresponse()
        response.read(1)
        # 401/403 同样说明路由已注册（鉴权在处理器内部），404 才是没挂上。
        return response.status != 404
    except (OSError, http.client.HTTPException):
        return False
    finally:
        connection.close()


# 等待受超时约束：插件一直挂不上时不把「服务起不来」升级成故障 —— 那是插件自身的问题，
# 不是生命周期问题 —— 但调用方会从返回的 ready=false 看到真相。
def wait_plugin_ready():
    if not profile_has_plugin(PLUGIN_READY_BUNDLE):
        return True
    deadline = time.monotonic() + PLUGIN_READY_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        if plugin_ready():
            return True
        time.sleep(0.2)
    return False


def status_payload():
    pid = read_pid()
    running = process_running(pid)
    web_up = web_ready()
    # ready 的含义是「浏览器现在连上去会正常工作」，所以插件也要挂上。用 404 而不是等待来
    # 避免 status 变慢：插件还没挂时它立刻返回 404，插件挂了返回 200/401。
    # 不带该插件的 profile 直接以根页面为准，不探一条永远 404 的路由。
    plugin_up = plugin_ready() if profile_has_plugin(PLUGIN_READY_BUNDLE) else True
    ready = web_up and plugin_up
    if running and ready:
        state = "running"
    elif running:
        state = "starting"
    elif port_open():
        state = "unmanaged"
    else:
        state = "stopped"
    return {
        "integrationVersion": DSH_INTEGRATION_VERSION,
        "state": state,
        "ready": ready,
        "pid": pid if running else None,
        "host": DSH_HOST,
        "port": DSH_PORT,
        "rootPath": "/",
        "workspaceRoot": str(WORKSPACE_ROOT),
        "workspaceRootPersisted": is_volume_backed(WORKSPACE_ROOT),
        "home": str(DSH_HOME),
        "logPath": str(LOG_PATH),
        "sourceRef": os.environ.get("DATAOPS_DSH_SOURCE_REF", "").strip() or None,
        "profile": DSH_PROFILE,
        "profileVariant": DSH_PROFILE_VARIANT or None,
        "profileSourceRef": DSH_PROFILE_SOURCE_REF or None,
    }


def profile_payload():
    """Report which profile the workspace is bound to and what it mounts.

    Assembling the profile is the only operation this reports on. It exists so image
    verification and operations can prove the default profile carries no IM bundle while the
    `im-test` variant does, without booting DSH or starting a browser.
    """
    bundles = []
    package_path = PROFILE_DIR / "package.json"
    try:
        package = json.loads(package_path.read_text("utf-8"))
        bundles = list(((package.get("dsh") or {}).get("profile") or {}).get("bundles") or [])
    except (OSError, ValueError):
        bundles = []
    return {
        "profile": DSH_PROFILE,
        "profileVariant": DSH_PROFILE_VARIANT or None,
        "profilePath": str(PROFILE_DIR),
        "profileSourceRef": profile_source_marker(PROFILE_DIR) or None,
        "bundles": bundles,
        "bundleCount": len(bundles),
        "hasImBundle": "@xmanrui/dsh-im" in bundles,
    }


def tail_log(max_bytes=8192):
    if not LOG_PATH.is_file():
        return ""
    with LOG_PATH.open("rb") as source:
        source.seek(0, os.SEEK_END)
        size = source.tell()
        source.seek(max(0, size - max_bytes))
        return source.read().decode("utf-8", "replace").strip()


def stop_pid(pid):
    if not process_running(pid):
        return
    try:
        os.killpg(pid, signal.SIGTERM)
    except ProcessLookupError as exc:
        traceback.print_exception(exc, file=sys.stderr)
        return
    deadline = time.monotonic() + STOP_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        if not process_running(pid):
            return
        time.sleep(0.1)
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError as exc:
        traceback.print_exception(exc, file=sys.stderr)
        return
    kill_deadline = time.monotonic() + 2
    while time.monotonic() < kill_deadline and process_running(pid):
        time.sleep(0.05)


INTERNAL_TOKEN_FILE = pathlib.Path("/run/dataops-workspace/internal-token")


def build_dsh_environment():
    environment = os.environ.copy()
    environment["DSH_HOME"] = str(DSH_HOME)
    environment["DATAOPS_DSH_EMBEDDED"] = "1"
    # A box whose network policy blocks a search provider's origin can point the DSH process at
    # a local egress proxy without changing the image. The extra env file lives on the persistent
    # DSH home (0600) and is absent by default; only the four proxy launch names are accepted.
    proxy_env_path = DSH_HOME / "anysearch-proxy.env"
    if proxy_env_path.is_file():
        try:
            for raw_line in proxy_env_path.read_text("utf-8").splitlines():
                line = raw_line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                value = value.strip().strip("'\"")
                if key in {"NODE_USE_ENV_PROXY", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"} and value:
                    environment.setdefault(key, value)
        except OSError:
            pass
    # The MCP server config expands `${DATAOPS_AI_WORKSPACE_INTERNAL_TOKEN}` from this process
    # environment, and without it every MCP call is rejected with 401. `/run` is per-container, so
    # a restart loses the file until the backend re-injects it; read the file here so a plain
    # `dataops-dsh-service start` works for containers created before the env injection existed.
    # The value is never logged or echoed.
    if not environment.get("DATAOPS_AI_WORKSPACE_INTERNAL_TOKEN"):
        # The token file is 0640 nobody:nogroup inside a 0700 directory, so this root process is
        # refused even though it owns the container. Read it through the same unprivileged user
        # the entrypoint uses for the sidecars; the value is never logged.
        try:
            read = subprocess.run(
                ["setpriv", "--reuid=65534", "--regid=65534", "--clear-groups",
                 "cat", str(INTERNAL_TOKEN_FILE)],
                capture_output=True, text=True, timeout=10, check=False,
            )
        except (OSError, subprocess.SubprocessError):
            read = None
        token = (read.stdout if read is not None and read.returncode == 0 else "").strip()
        if not token:
            try:
                token = INTERNAL_TOKEN_FILE.read_text("utf-8").strip()
            except OSError:
                token = ""
        if token:
            environment["DATAOPS_AI_WORKSPACE_INTERNAL_TOKEN"] = token
    return environment


def apply_approval_policy_patches():
    """Restore the DataOps `allow` policy on every loadable tree after a base refresh.

    Upstream 0.2.x only knows ask/never; the DataOps overlay intentionally selects allow for
    danger-full-access. The patch script is idempotent and patches the runtime, the template,
    and the volume profile so an image refresh cannot silently remove the policy.
    """
    script = "/usr/local/lib/patch-approval-allow.mjs"
    if not os.path.exists(script):
        return
    command = [
        "node",
        script,
        "/opt/dsh-plus",
        "/opt/dataops-dsh-profile-template",
        str(PROFILE_DIR),
    ]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=30, check=False)
    except (OSError, subprocess.SubprocessError) as exc:
        log_message(f"approval policy patch failed to run: {exc}")
        return
    output = (result.stdout or "") + (result.stderr or "")
    if output.strip():
        log_message("approval policy patch:\n" + output.strip())
    if result.returncode != 0:
        log_message(f"approval policy patch exited with {result.returncode}")


def start_service():
    # 只有启动会把工作区根注册进 DSH，所以判据放在这里而不是 ensure_contract：stop/status 必须
    # 保持可用，否则根一旦配错就再也停不下来。也放在 prepare_directories 之前，避免在卷外建
    # 出 runtime/log 目录，并且先于其它契约检查，好让「根不在卷上」这个可操作的诊断胜出。
    ensure_workspace_root_is_durable()
    ensure_contract()
    prepare_directories()
    # Before the lock and before the running-instance early return: `ensure` also reaches
    # here, and an existing volume may be missing the deployment key. A running DSH keeps
    # its old env until the next start, which is exactly when this line is read.
    seed_workspace_env()
    repair_workspace_record()
    with LOCK_PATH.open("a+") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        current = status_payload()
        if current["state"] == "running":
            return current
        if current["state"] == "unmanaged":
            raise ServiceError(
                "DSH_PORT_ALREADY_IN_USE",
                f"{DSH_HOST}:{DSH_PORT} is already in use by a process not owned by DataOps DSH lifecycle.",
            )
        # 一个已经活着、只是插件还没挂完的实例不能被当成「需要重启」：ensure 是按需调用的，
        # 启动窗口里被调用一次就会杀掉正在激活的进程，重启窗口越叠越长。先等它激活。
        if current["state"] == "starting" and wait_plugin_ready():
            return status_payload()

        stale_pid = read_pid()
        if stale_pid and process_running(stale_pid):
            stop_pid(stale_pid)
        PID_PATH.unlink(missing_ok=True)
        clear_stale_profile_lock()
        prepare_profile()
        # After the replacement, not before: the template already has the retired package
        # removed, but the volume profile keeps the user patch and `$DSH_HOME/skills` sits
        # outside the directory prepare_profile() replaces.
        remove_obsolete_managed_skills()
        apply_approval_policy_patches()
        # Separate from prepare_profile(): that function's contract is to retain the user
        # patch byte-for-byte across an image refresh, which the image verification asserts.
        # A profile first copied from an older template keeps its provider list verbatim, so
        # the local provider added to the template only reaches it through this additive seed.
        seed_local_provider()
        # The provider can predate the current self-hosted model or declare text only;
        # refresh it from the template so existing profiles inherit image input and the
        # current image budgets instead of keeping a text-only block forever.
        align_local_provider()
        # One-time migration first: the old TokensFree seed is replaced by the routable
        # baseline, while a later explicit TokensFree choice is protected by the marker.
        migrate_legacy_default_model()
        # An earlier migration run may have left the auto marker on the pre-migration pair.
        repair_migrated_auto_selection()
        # The baseline model is seeded only when the profile has no selection at all.
        seed_default_model()
        # Same contract for the appearance: only a profile that states no theme preference is
        # seeded, so a user's light or system choice is never overwritten. The settings document
        # is seeded beside it because the row pre-paints the page while the client theme store
        # reads the settings snapshot -- dark needs both.
        seed_default_theme()
        seed_theme_settings()

        environment = build_dsh_environment()
        # launcher只安装managed MCP overlay；profile提供托管Settings与批量分析插件。
        command = [
            "setpriv",
            "--bounding-set=-all",
            "--",
            "node",
            str(DSH_ENTRY),
            "--profile",
            DSH_PROFILE,
            "--patch",
            str(DSH_EMBEDDED_DATAOPS_PATCH),
            "--host",
            DSH_HOST,
            "--port",
            str(DSH_PORT),
            "--no-open",
        ]
        with LOG_PATH.open("ab", buffering=0) as log_file:
            log_file.write(
                (f"\n[dataops-dsh-service] starting {' '.join(command)}\n").encode("utf-8")
            )
            process = subprocess.Popen(
                command,
                cwd=str(WORKSPACE_ROOT),
                env=environment,
                stdin=subprocess.DEVNULL,
                stdout=log_file,
                stderr=subprocess.STDOUT,
                start_new_session=True,
                close_fds=True,
            )
        PID_PATH.write_text(f"{process.pid}\n", encoding="utf-8")

        deadline = time.monotonic() + START_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            exit_code = process.poll()
            if exit_code is not None:
                PID_PATH.unlink(missing_ok=True)
                diagnostic = tail_log()
                raise ServiceError(
                    "DSH_START_FAILED",
                    f"DSH Web exited before readiness (exit code {exit_code})."
                    + (f"\n{diagnostic}" if diagnostic else ""),
                )
            if web_ready():
                # Web 路由已挂上，但插件树可能还在激活。start 的调用方拿到返回值就会把
                # 这个实例宣告给浏览器，所以这里必须等到插件也挂完；否则页面会连上
                # 一个没有插件路由的实例并停在「重新连接中」。
                if wait_plugin_ready():
                    return status_payload()
                # 等到超时仍未挂上：不把「服务起不来」升级成故障（插件自身的问题不是生命周期
                # 问题），但也如实返回当前状态，让调用方看到 ready=false。
                return status_payload()
            time.sleep(0.1)

        stop_pid(process.pid)
        PID_PATH.unlink(missing_ok=True)
        diagnostic = tail_log()
        raise ServiceError(
            "DSH_START_TIMEOUT",
            f"DSH Web did not become ready on {DSH_HOST}:{DSH_PORT} within {START_TIMEOUT_SECONDS:g}s."
            + (f"\n{diagnostic}" if diagnostic else ""),
        )


def stop_service():
    ensure_contract()
    prepare_directories()
    with LOCK_PATH.open("a+") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        pid = read_pid()
        if pid and process_running(pid):
            stop_pid(pid)
        PID_PATH.unlink(missing_ok=True)
        return status_payload()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["status", "start", "ensure", "stop", "profile"])
    args = parser.parse_args()
    try:
        if args.command == "status":
            ensure_contract()
            prepare_directories()
            result = status_payload()
        elif args.command == "profile":
            # Assemble (or report) the volume profile without starting DSH. Verification and
            # operations use it to prove which bundle rows a workspace's template resolves to.
            ensure_contract()
            prepare_directories()
            prepare_profile()
            result = profile_payload()
        elif args.command in {"start", "ensure"}:
            result = start_service()
        else:
            result = stop_service()
        emit({"ok": True, **result})
    except ServiceError as exc:
        traceback.print_exception(exc, file=sys.stderr)
        emit({"ok": False, "code": exc.code, "message": exc.message})
        raise SystemExit(1)
    except Exception as exc:
        traceback.print_exception(exc, file=sys.stderr)
        emit({"ok": False, "code": "DSH_SERVICE_FAILED", "message": str(exc)})
        raise SystemExit(1)


if __name__ == "__main__":
    main()
