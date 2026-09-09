# @sparkelf/dsh-patch-composer-popover-boundaries

[English](README.md) | 中文

该data-only package让official composer的Permission与Model portal菜单保持在AppFrame center column内。它增加私有center-owner标记，使shared Menu把viewport定位与owner boundary取交集，并把相同计算应用到专用Model卡片。Sidebar或右侧面板把center压窄时，两个菜单仍保留12px横向间距。

target是exact official source revision `b2e3b2a0125854567a4a5fcba75782e42fe84901`。payload只包含聚焦的生产修改、所属package合同及既有component与Web用户路径覆盖；不会恢复已retire的Plus mobile layout、Sidebar、Settings、Jobs、Schedule或responsive-column改动。

对应upstream贡献进入official DSH release后，retire本package。
