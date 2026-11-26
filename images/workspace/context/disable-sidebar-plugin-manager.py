#!/usr/bin/env python3
"""Disable the sidebar「插件」entry at image-build time.

The entry belongs to the official `ui-plugin-manager` row inserted by
`@deepseek-ai/dsh-web-app`. DataOps does not ship a plugin install surface, so the
row must be disabled. The runtime `--patch` overlay can do it, but that overlay is
baked into a prebuilt `runtime-files` image layer; a build that does not carry the
row would silently bring「插件」back. Writing the disable row into the profile's own
`cordis.patch.yml` puts the decision in the profile the image ships.

Guards, in the order they run:
1. the bundle must still declare `- id: ui-plugin-manager` (otherwise the preset
   rename makes this script meaningless), and a mismatch prints every id found;
2. the profile patch gets exactly one top-level `- id: ui-plugin-manager` row with
   `disabled: true` (created, appended, or normalized);
3. `dsh --dump-config` must show the composed row with `disabled: true`, otherwise
   the build fails instead of shipping a sidebar entry nobody verified.

Idempotent: a profile that already satisfies the row is reported and left alone.

Usage: disable-sidebar-plugin-manager.py [profile-dir]
"""
import os
import pathlib
import re
import subprocess
import sys

ROW_ID = "ui-plugin-manager"
BUNDLE = "@deepseek-ai/dsh-web-app"
PATCH_FILE = "cordis.patch.yml"
BLOCK = (
    "\n# DataOps does not ship a plugin install surface. This is the official sidebar panel and\n"
    "# plugin management page; the host half is already disabled in a standalone profile, so the\n"
    "# client row would render a page whose actions cannot work.\n"
    "- id: ui-plugin-manager\n"
    "  disabled: true\n"
)


def fail(message: str) -> int:
    print(f"disable-sidebar-plugin-manager: FAIL {message}")
    return 1


def bundle_ids(patch_path: pathlib.Path) -> list[str]:
    return re.findall(r"^\s*-\s*id:\s*([A-Za-z0-9._-]+)\s*$", patch_path.read_text(encoding="utf-8"), re.MULTILINE)


def row_blocks(text: str) -> list[tuple[int, int]]:
    """Top-level row ranges as (start, end) line indexes (end exclusive)."""
    lines = text.splitlines()
    starts = [index for index, line in enumerate(lines) if re.match(r"^-\s+id:\s*", line) or re.match(r"^-\s+id:\s*\S", line)]
    return [(start, starts[position + 1] if position + 1 < len(starts) else len(lines)) for position, start in enumerate(starts)]


def ensure_row(text: str) -> tuple[str, str]:
    lines = text.splitlines()
    blocks = row_blocks(text)
    target = None
    for start, end in blocks:
        if re.match(rf"^-\s+id:\s*{re.escape(ROW_ID)}\s*$", lines[start]):
            target = (start, end)
            break
    if target is None:
        suffix = "" if text.endswith("\n") else "\n"
        return text + suffix + BLOCK, "appended"
    start, end = target
    for index in range(start + 1, end):
        if re.match(r"^\s+disabled:\s*\S+", lines[index]):
            if lines[index].strip() == "disabled: true":
                return text, "already disabled"
            lines[index] = "  disabled: true"
            return "\n".join(lines) + "\n", "normalized disabled"
    lines.insert(start + 1, "  disabled: true")
    return "\n".join(lines) + "\n", "inserted disabled"


def composed_disabled(node: str, home: pathlib.Path, profile: str) -> tuple[bool, str]:
    command = [node, str(home / "profiles" / profile / "node_modules" / "@deepseek-ai" / "dsh" / "lib" / "bin.js"),
               "--dump-config", "--profile", profile]
    environment = dict(os.environ)
    environment["DSH_HOME"] = str(home)
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=180, check=False, env=environment)
    except (OSError, subprocess.SubprocessError) as error:
        return False, f"dump-config could not run: {error}"
    output = (result.stdout or "") + (result.stderr or "")
    lines = output.splitlines()
    for index, line in enumerate(lines):
        if re.match(rf"^-\s+id:\s*{re.escape(ROW_ID)}\s*$", line):
            for follower in lines[index + 1:index + 14]:
                if re.match(r"^-\s+id:\s*", follower):
                    break
                if follower.strip() == "disabled: true":
                    return True, "\n".join(lines[index:index + 4])
    return False, f"dump-config exit={result.returncode}; no composed '{ROW_ID}' row with disabled: true\n" + output[-2000:]


def main() -> int:
    profile_directory = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "/opt/dsh-home/profiles/dataops-web").resolve()
    if not (profile_directory / "package.json").is_file():
        return fail(f"no profile manifest at {profile_directory}")
    home = profile_directory.parent.parent
    profile = profile_directory.name

    bundle_patch = profile_directory / "node_modules" / BUNDLE / PATCH_FILE
    if not bundle_patch.is_file():
        return fail(f"{BUNDLE} patch missing: {bundle_patch}")
    ids = bundle_ids(bundle_patch)
    if ROW_ID not in ids:
        return fail(f"{BUNDLE} no longer declares '{ROW_ID}'; ids found: {', '.join(ids)}")
    print(f"disable-sidebar-plugin-manager: {BUNDLE} declares {ROW_ID} ({len(ids)} ids)")

    patch_path = profile_directory / PATCH_FILE
    if patch_path.is_file():
        text = patch_path.read_text(encoding="utf-8")
    else:
        text = (
            "# DataOps profile patch. prepare_profile() keeps this file byte-for-byte across a\n"
            "# template refresh, so deployment policy lives here rather than in runtime-files.\n"
        )
        print(f"disable-sidebar-plugin-manager: created {patch_path}")
    updated, status = ensure_row(text)
    if updated != text:
        patch_path.write_text(updated, encoding="utf-8")
    print(f"disable-sidebar-plugin-manager: {PATCH_FILE}: {status}")

    node = os.environ.get("DSH_NODE") or "node"
    verified, detail = composed_disabled(node, home, profile)
    if not verified:
        return fail("composed configuration does not disable the row\n" + detail)
    print("disable-sidebar-plugin-manager: dump-config confirms")
    print(detail)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())