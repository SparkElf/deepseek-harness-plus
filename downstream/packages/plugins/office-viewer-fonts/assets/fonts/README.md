# Government and Office fonts

These font binaries are distributed by SparkElf under authorization for this package. They are not covered by the repository MIT license.

Each file's family name is the Chinese name a government document asks for, because the Office
converter matches a requested typeface against the family names a font declares and the match is
on the name itself: a Word report names `仿宋`, and a file whose family is only `FangSong_GB2312`
is reported to the reader as an unavailable font even though its glyphs are the ones the document
wants. The suffixed names are what the fonts originally carried.

`Calibri*.ttf` are the Microsoft Office faces supplied from the licensed Windows host for
workspace Office conversion. Their family names are already `Calibri` and `Calibri Light`; the
converter therefore resolves them without a fontconfig alias.

| File | Family name | Original family |
|---|---|---|
| `FZXiaoBiaoSong.ttf` | `方正小标宋简体` | `FZXiaoBiaoSong-B05S` |
| `FZXiaoBiaoSong-JT.ttf` | `方正小标宋简体` (JT) | `FZXiaoBiaoSong-B05S-JT` |
| `FangSongGB2312.ttf` | `仿宋` | `FangSong_GB2312` |
| `FangSong.ttf` | `仿宋` (FangSong) | `FangSong` |
| `KaiTiGB2312.ttf` | `楷体` | `KaiTi_GB2312` |
| `KaiTi.ttf` | `楷体` (KaiTi) | `KaiTi` |
| `SimHei.ttf` | `黑体` | `SimHei` |
| `Arial.ttf` | `Arial` | `ArialMT` |
| `Arial-Bold.ttf` | `Arial` | `Arial-BoldMT` |
| `Arial-Italic.ttf` | `Arial` | `Arial-ItalicMT` |
| `Arial-BoldItalic.ttf` | `Arial` | `Arial-BoldItalicMT` |
| `Calibri.ttf` | `Calibri` | `Calibri` |
| `Calibri-Bold.ttf` | `Calibri` | `Calibri Bold` |
| `Calibri-Italic.ttf` | `Calibri` | `Calibri Italic` |
| `Calibri-BoldItalic.ttf` | `Calibri` | `Calibri Bold Italic` |
| `Calibri-Light.ttf` | `Calibri Light` | `Calibri Light` |
| `Calibri-LightItalic.ttf` | `Calibri Light` | `Calibri Light Italic` |
