# @sparkelf/dsh-patch-mobile-web-layout

[English](README.md) | 中文

该data-only package补全official Web shell的responsive behavior。AppFrame width不超过640px时，user-expanded main navigation column占精确一半measured frame，conversation占另一半，details保持closed，且不显示sidebar drag handle。Composer controls分阶段收缩；permission与model popover保持在center column内，与collapsed rail及右边缘各保留12px间距；当可用区间比菜单更窄时，菜单会缩小以适配。collapsed 56px rail、tablet behavior、desktop drag preference、Session selection与Workspace addition保持official且不变。

target是exact official source base `d347e703908d0406b7a7ef80e3a0e594d86b2215`。本payload拥有该behavior所需的responsive AppFrame、composer controls、shared popover placement primitives、model menu与permission menu。本package没有JavaScript entry、lifecycle script或fallback variant。

official Web发布等价phone navigation、compact composer controls与center-column popover placement后，retire本package。
