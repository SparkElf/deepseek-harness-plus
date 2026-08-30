# @sparkelf/dsh-patch-session-log-trajectory-toolbar

[English](README.md) | 中文

该data-only package在桌面屏幕上把official会话日志下载操作放到Trajectory搜索框紧邻左侧。该操作使用Trajectory toolbar的紧凑高度、字体、颜色、hover状态与focus样式，不再使用Session Header胶囊样式。宽度不超过767 px的屏幕保留official Header位置及样式。

payload增加一个typed Trajectory toolbar utility slot，并把既有会话日志操作的第二个presentation注册进该slot。两个presentation共用同一个download controller、request、state与dialog；本package不增加第二条export path或archive implementation。

target是exact official source revision `0a53fb55bea101816fa226bb964ae2bed71c343b`，payload在该source tree build前应用。本package没有JavaScript entry、lifecycle script、Cordis plugin、compatibility adapter或alternate variant。

official DSH暴露等价Trajectory toolbar utility slot，并在桌面端把Session export放到搜索框前、同时在手机上保留Header操作后，retire本package。
