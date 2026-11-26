"""Publish a second spelling for a face that already carries the glyphs.

`relabel-font.py` gives one file one spelling. A document may name the same typeface by two
spellings that the converter does not fold together -- it folds case and separators only, so
`仿宋` and `仿宋_GB2312` are different requests, and so are `Arial` and `Liberation Sans`.
Answering both from one family entry is impossible, so this writes a copy that carries the
other spelling.

Two name layers have to agree, and they are read by different code:

* The converter's own catalog reads every recorded name and folds case and separators. That is
  what decides whether a family is reported as missing.
* fontconfig inside the conversion engine matches a *family*, not a PostScript name. A face
  whose family is `仿宋` alone answers `仿宋` but sends `FangSong` to a generic fallback, which
  is how CJK text ended up in a Latin face with no CJK glyphs.

Windows fonts solve this with one family name per language: `FangSong` in en-US, `仿宋` in
zh-CN. This writes the same shape -- the Latin spelling into the 0x409 records, the Chinese
spelling into the 0x804 records, and the PostScript name into both -- so both spellings reach
the same file. Mac-platform records are written only when the value is ASCII, because they
encode Mac Roman and a CJK value cannot be stored there.

The copy is a full font, not an alias record: an alias that lives only in fontconfig never
reaches the converter's catalog, so it cannot clear the "missing fonts" notice.
"""
import shutil
import sys

from fontTools.ttLib import TTFont

FAMILY_ID = 1
SUBFAMILY_ID = 2
TYPOGRAPHIC_FAMILY_ID = 16
FULL_NAME_ID = 4
POSTSCRIPT_ID = 6
WINDOWS_PLATFORM = 3
MAC_PLATFORM = 1
LANG_EN_US = 0x409
LANG_ZH_CN = 0x804


def write_windows(table, name_id, value, language):
    """Overwrite one name in a single Windows language, leaving other languages alone."""
    written = 0
    for record in list(table.names):
        if record.platformID != WINDOWS_PLATFORM or record.nameID != name_id or record.langID != language:
            continue
        table.setName(value, name_id, record.platformID, record.platEncID, record.langID)
        written += 1
    return written


def write_mac(table, name_id, value):
    """Overwrite Mac records when the value survives Mac Roman, which CJK does not."""
    if not value.isascii():
        return 0
    written = 0
    for record in list(table.names):
        if record.platformID != MAC_PLATFORM or record.nameID != name_id:
            continue
        table.setName(value, name_id, record.platformID, record.platEncID, record.langID)
        written += 1
    return written


def subfamily(table):
    """Read the face's own subfamily spelling, which decides the full name."""
    for record in table.names:
        if record.platformID == WINDOWS_PLATFORM and record.nameID == SUBFAMILY_ID:
            try:
                return record.toUnicode()
            except UnicodeDecodeError:
                continue
    return "Regular"


def main(argv):
    """Copy argv[1] to argv[2] and write argv[3]/argv[4]/argv[5] into the copy."""
    source, target, family, postscript = argv[:4]
    latin = argv[4] if len(argv) > 4 else family
    shutil.copyfile(source, target)
    font = TTFont(target)
    table = font["name"]
    style = subfamily(table)
    suffix = "" if style.lower() == "regular" else " " + style
    written = 0
    for name_id, value in ((FAMILY_ID, latin), (TYPOGRAPHIC_FAMILY_ID, latin), (FULL_NAME_ID, latin + suffix), (POSTSCRIPT_ID, postscript)):
        written += write_windows(table, name_id, value, LANG_EN_US)
    for name_id, value in ((FAMILY_ID, family), (TYPOGRAPHIC_FAMILY_ID, family), (FULL_NAME_ID, family + suffix), (POSTSCRIPT_ID, postscript)):
        written += write_windows(table, name_id, value, LANG_ZH_CN)
    for name_id, value in ((FAMILY_ID, latin), (TYPOGRAPHIC_FAMILY_ID, latin), (FULL_NAME_ID, latin + suffix), (POSTSCRIPT_ID, postscript)):
        written += write_mac(table, name_id, value)
    font.save(target)
    print("  " + target + " -> family=" + family + " latin=" + latin + " postscript=" + postscript + " (" + str(written) + " records)")


if __name__ == "__main__":
    main(sys.argv[1:])