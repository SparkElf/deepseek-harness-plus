# @sparkelf/dsh-patch-mobile-web-layout

[English](README.md) | 中文

该data-only package补充official Web shell剩余的responsive gap：AppFrame width不超过640px时，user-expanded main navigation column占精确一半measured frame，conversation占另一半，details保持closed，且不显示sidebar drag handle。collapsed 56px rail、tablet behavior、desktop drag preference、Session selection与Workspace addition保持official且不变。

target是exact official source base `cd5ef8148158c3a752a658978873241fdf8e2bbc`。official后续composer-control与model-menu mobile fixes直接继承，不在payload中复制。本package没有JavaScript entry、lifecycle script或fallback variant。

official AppFrame发布等价phone half-width navigation后，retire本package。
