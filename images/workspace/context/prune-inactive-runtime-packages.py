#!/usr/bin/env python3
"""Drop runtime packages the profile still installs but never mounts.

`dsh-plus apply` copies the distribution's baseline `profile.dependencies` into the
profile manifest, so a team-edition image still installs packages the edition did not
put in `dsh.profile.bundles` — mobile-bridge and quant are the known pair. They are
inactive (the launcher never mounts them), but they stay on disk, which a "the image
must not contain this capability" check can see.

This prunes them at build time: the dependency line, the installed entry, and then a
set of assertions that fail the build if anything is left. A package that is still
listed in `dsh.profile.bundles` is refused outright: deleting its directory would
turn a dormant package into an unresolved bundle at the next boot.

Idempotent: a profile that already lacks every target reports `clean` and exits 0.

Usage:
  prune-inactive-runtime-packages.py [--profile DIR] [--dry-run]
                                     [--package NAME ...]
"""
import argparse
import json
import os
import pathlib
import shutil

DEFAULT_PACKAGES = ("@sparkelf/dsh-mobile-bridge", "@sparkelf/dsh-quant")
DEPENDENCY_FIELDS = ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies")


def remove_path(path: pathlib.Path) -> str:
    if not path.exists() and not path.is_symlink():
        return "absent"
    if path.is_symlink():
        path.unlink()
        return "unlinked"
    shutil.rmtree(path)
    return "removed"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", default="/opt/dsh-home/profiles/dataops-web")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--package", action="append", dest="packages")
    parser.add_argument(
        "--unmount",
        action="store_true",
        help="also drop the package row from dsh.profile.bundles; image builds use this "
             "for a package the profile mounts only because it sits on the baseline list",
    )
    arguments = parser.parse_args()

    profile = pathlib.Path(arguments.profile).resolve()
    manifest_path = profile / "package.json"
    if not manifest_path.is_file():
        print(f"prune-inactive-runtime-packages: FAIL no profile manifest at {profile}")
        return 2
    packages = arguments.packages or list(DEFAULT_PACKAGES)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    bundles = manifest.get("dsh", {}).get("profile", {}).get("bundles", [])

    active = [name for name in packages if name in bundles]
    changed = False
    if active and arguments.unmount:
        manifest.setdefault("dsh", {}).setdefault("profile", {})["bundles"] = [
            bundle for bundle in bundles if bundle not in packages
        ]
        bundles = manifest["dsh"]["profile"]["bundles"]
        changed = True
        for name in active:
            print(f"prune-inactive-runtime-packages: unmounted {name} from dsh.profile.bundles")
        active = []
    if active:
        print(
            "prune-inactive-runtime-packages: FAIL refusing to prune packages the profile still mounts: "
            + ", ".join(active)
            + "\n  dsh.profile.bundles: "
            + json.dumps([bundle for bundle in bundles if bundle in packages])
        )
        return 1

    for name in packages:
        for field in DEPENDENCY_FIELDS:
            if name in manifest.get(field, {}):
                del manifest[field][name]
                changed = True
                print(f"prune-inactive-runtime-packages: removed dependency {name} from {field}")
        state = "would remove" if arguments.dry_run else remove_path(profile / "node_modules" / name)
        print(f"prune-inactive-runtime-packages: node_modules/{name}: {state}")

    if changed and not arguments.dry_run:
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    if arguments.dry_run:
        print("prune-inactive-runtime-packages: dry-run clean (" + ", ".join(packages) + ")")
        return 0

    remaining = []
    for name in packages:
        if name in bundles:
            remaining.append(f"{name}: still in dsh.profile.bundles")
        if any(name in manifest.get(field, {}) for field in DEPENDENCY_FIELDS):
            remaining.append(f"{name}: still declared as a dependency")
        entry = profile / "node_modules" / name
        if entry.exists() or entry.is_symlink():
            remaining.append(f"{name}: still present at {entry}")
    if remaining:
        print("prune-inactive-runtime-packages: FAIL residual state\n  " + "\n  ".join(remaining))
        return 1

    print("prune-inactive-runtime-packages: clean (" + ", ".join(packages) + ")")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())