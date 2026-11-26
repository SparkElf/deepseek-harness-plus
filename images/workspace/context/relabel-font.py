"""Give a font the names a document uses for it.

The Office converter matches a requested typeface against the names a font file declares,
reading two of them per face: the family name and the PostScript name. It compares them
case- and separator-insensitively. Nothing here consults fontconfig, so a `<match>` alias in
a fontconfig file never reaches it -- measured 2026-10-11, after adding those aliases the
workspace still reported 方正小标宋_GBK, 宋体 and Times New Roman as unavailable.

The faces the image ships already carry the glyphs a government document asks for; only the
spelling differs. This writes the document's spelling into the face. A face exposes one family
name, so a second spelling goes to the PostScript name -- which is exactly why 仿宋_GB2312
already resolved: that face declares 仿宋 and carries FangSong_GB2312 as its PostScript name.

Only Windows-platform records are written. The Mac records in these files encode as Mac Roman,
which cannot represent CJK, and writing one raises rather than storing a usable name.
"""
import sys
from fontTools.ttLib import TTFont, TTCollection

FAMILY_ID = 1
TYPOGRAPHIC_FAMILY_ID = 16
FULL_NAME_ID = 4
POSTSCRIPT_ID = 6
WINDOWS_PLATFORM = 3


def write(table, name_id, value):
    """Overwrite one name across the Windows records that carry it."""
    written = 0
    for record in list(table.names):
        if record.platformID != WINDOWS_PLATFORM or record.nameID != name_id:
            continue
        table.setName(value, name_id, record.platformID, record.platEncID, record.langID)
        written += 1
    return written


def face_names(table):
    """Read every Windows name a face exposes, so a filter may match any spelling."""
    names = []
    for record in table.names:
        if record.platformID != WINDOWS_PLATFORM or record.nameID not in (FAMILY_ID, TYPOGRAPHIC_FAMILY_ID):
            continue
        try:
            names.append(record.toUnicode())
        except UnicodeDecodeError:
            continue
    for record in table.names:
        if record.platformID == WINDOWS_PLATFORM and record.nameID == POSTSCRIPT_ID:
            try:
                names.append(record.toUnicode())
            except UnicodeDecodeError:
                continue
    return names

def relabel(font, family, postscript, family_filter=None):
    """Rename one face, returning how many records changed."""
    table = font["name"]
    if family_filter is not None and family_filter not in face_names(table):
        return 0
    written = write(table, FAMILY_ID, family)
    written += write(table, TYPOGRAPHIC_FAMILY_ID, family)
    written += write(table, FULL_NAME_ID, family)
    if postscript is not None:
        written += write(table, POSTSCRIPT_ID, postscript)
    return written


def main(arguments):
    """apply a rename to every face of the file at argv[1]."""
    path = arguments[0]
    family = arguments[1]
    postscript = arguments[2] if len(arguments) > 2 else None
    # A collection holds several faces; only the one a document on this platform names is
    # relabelled, and the filter selects it by the family it declares.
    collection_filter = arguments[3] if len(arguments) > 3 else None
    if path.lower().endswith(".ttc"):
        collection = TTCollection(path)
        written = sum(relabel(face, family, postscript, collection_filter) for face in collection.fonts)
        collection.save(path)
    else:
        font = TTFont(path)
        written = relabel(font, family, postscript)
        font.save(path)
    print("  " + path.rsplit("/", 1)[-1] + " -> family=" + family + " postscript=" + str(postscript) + " (" + str(written) + " records)")


if __name__ == "__main__":
    main(sys.argv[1:])
