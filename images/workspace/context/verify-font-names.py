"""Fail the build when a face the converter needs does not declare its name.

The converter reads a font's name table with fontkit and compares the family and PostScript
names case- and separator-insensitively. fontconfig is not consulted, and fc-match answers a
best-match query rather than an exact lookup -- measured 2026-10-12, four of six required names
resolved to a Noto face while the target face declared the requested name correctly. This reads
the same records the converter reads.
"""
import os
import sys

from fontTools.ttLib import TTFont, TTCollection

WINDOWS_PLATFORM = 3
NAME_IDS = (1, 16, 6)


def declared_names(table):
    """Read every Windows name record the converter may compare against."""
    values = set()
    for record in table.names:
        if record.platformID != WINDOWS_PLATFORM or record.nameID not in NAME_IDS:
            continue
        try:
            values.add(record.toUnicode())
        except UnicodeDecodeError:
            continue
    return values


def fold(value):
    """Normalize a name the way the converter does: case- and separator-insensitive."""
    return "".join(character for character in value.lower() if character.isalnum())


def main(argv):
    """Check that every requested family is declared by a face under the given root."""
    root, wanted = argv[0], argv[1:]
    declared = set()
    for name in sorted(os.listdir(root)):
        path = os.path.join(root, name)
        if name.lower().endswith(".ttc"):
            faces = [face["name"] for face in TTCollection(path).fonts]
        elif name.lower().endswith(".ttf"):
            faces = [TTFont(path)["name"]]
        else:
            continue
        for table in faces:
            declared.update(fold(value) for value in declared_names(table))
    missing = [name for name in wanted if fold(name) not in declared]
    print("  " + str(len(declared)) + " names declared; missing: " + repr(missing))
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
