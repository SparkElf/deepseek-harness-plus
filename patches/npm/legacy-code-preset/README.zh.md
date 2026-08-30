# @sparkelf/dsh-patch-legacy-code-preset

[English](README.md) | 中文

该data-only package让official `code` agent preset改名为`ptc`之前创建的会话仍可恢复。恢复时先解析真实存在的`code` preset；只有`code`不存在时才回退到`ptc`。浏览器把该持久化旧id显示为本地化PTC preset，Session日志保持原样。

target是exact official source revision `0a53fb55bea101816fa226bb964ae2bed71c343b`，payload在该source tree build前应用。本package没有JavaScript entry、lifecycle script、Cordis plugin、accepted-fork fallback或alternate variant。

official DSH提供同等legacy preset解析与显示行为后，retire本package。
