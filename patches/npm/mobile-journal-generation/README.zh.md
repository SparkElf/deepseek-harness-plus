# @sparkelf/dsh-patch-mobile-journal-generation

[English](README.md) | 中文

该data-only package让被替换的Mobile Bridge journal generation保持关闭，直到opening snapshot到达。来自新carrier的buffered live entries不能在snapshot建立generation cursor之前替换已发布Session window。

target是exact official source revision `fb2c4b9e698e30edb738bca4cf0618587db7d203`。payload只修改API Gateway journal stream及其既有Client test；responsive layout、Sidebar、Composer与Mobile Bridge transport仍由当前owner持有。

official DSH发布replacement-generation ordering behavior后，retire本package。
