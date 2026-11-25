# @sparkelf/dsh-mobile-bridge

## 中文

DeepSeek Harness 的独立移动连接插件。默认连接 `https://www.tokensfree.eu.cc`（可在设置中修改），桌面端主动连接公网中继并每 30 秒发送标准 WebSocket 心跳以维持长时间浏览会话，手机通过一次性配对二维码访问本地 Harness；HTTP 与 Harness 应用 WebSocket 流量均使用端到端加密，中继服务器只读取外层设备路由 ID 并转发密文。手机登录页使用官方 DeepSeek 品牌和无外框布局，支持中英文及浅色/深色主题、深色可见网格和页面内相机扫码；相机会请求高分辨率后置画面，在设备支持时降低曝光并对可用焦距做一次清晰度评估后锁定最佳档位。decoder 按浏览器 capability 选择：原生 `BarcodeDetector` 由 `qr-scanner` 接入，其余浏览器在用户打开相机后才懒加载 ZXing-C++ WASM。两条路径都会框出识别到的二维码，首屏不下载 decoder JavaScript 或 WASM；手机在消费一次性票据前会确认 Service Worker 已接管页面。桌面端可设置手机关闭浏览器后的登录保持天数，默认 7 天。

插件同时拥有 Host 与 Client 两部分：Host 负责出站隧道与状态路由；Client 通过 Harness 的 `settings.section` Slot 注册“移动连接”，用于编辑服务器地址、本地端口、加密口令、所有者邮箱、扫码邮箱二因子，以及独立的启动自动连接和断线自动重连策略；页面提供主动连接/断开按钮，并持续显示配对二维码和六位配对码。加密口令是只写设置：页面只显示是否已设置，留空保存不会清除原值，输入新值才会替换。文本与数字在完成编辑时自动保存，开关在切换后立即保存；保存期间仍可继续编辑或切换开关，连接、断开与刷新会等待最新草稿保存成功，保存失败时不执行动作；保存只确认配置已写入，连接状态通过实时状态更新单独反馈；票据会在过期前或手机配对后自动换新，换新期间显示刷新动效且不再展示旧二维码。已配对设备列表显示在线状态、IP、首次配对和最近连接时间，桌面端可以逐台下线；其他设备和下一张配对票据不受影响；被下线手机会暂停全部 Harness 隧道请求，在当前 Harness 页面弹出下线提示与重新扫码操作；没有打开页面时，下一次访问仍显示重新扫码页。插件不提供独立 HTML 配置面板。同一持久化桌面身份被另一 Harness 实例接管时，中继会以 `4001 desktop reconnected` 结束旧连接；旧实例保持断开，不自动争抢身份，手机请求和事件流继续由新实例承载。

“远程 DOM 诊断”默认关闭，切换时不重建移动隧道。开启后，重新打开已配对手机页面即可开始；只有经端到端加密隧道访问 Harness 的手机会在页面加载和用户布局交互后按事件采集一份有界几何快照；快照包含 viewport、可见交互元素及其少量布局祖先的 role、aria label、class、data 属性名、矩形和 computed layout，不包含聊天文本、输入值或 URL query。Host 内存中每台设备只保留最新一份，并在已配对设备行显示 viewport、元素数和时间；本机 AI 可读取 `GET /mobile/bridge/diagnostics`。关闭开关会立即停止采集并清空全部快照。

### 安装

```sh
dsh plugin --profile web add @sparkelf/dsh-mobile-bridge@0.2.11
```

安装会通过包内 `dsh.bundle` 挂载 Host 插件，并通过 `dsh.client` 加载浏览器设置页面。手机端仅注入应用 WebSocket facade；Harness 界面的响应式样式继续由各界面所属包负责。禁用或移除该 bundle 会同时移除路由、连接和设置菜单。

`0.2.10` 直接通过公开 Settings service 注册并观察自己的 namespace，并使用 DSH alpha.2 的斜杠 Remote 路由与 `payload.args` 协议；运行时不依赖 alpha.2 已删除的 Settings helper export。

### 配置

| 字段 | 含义 |
|---|---|
| `serverUrl` | 公网移动桥接服务器的 HTTPS 地址 |
| `localPort` | 本机 Harness Web 端口 |
| `userKey` | 可选加密口令；设置后手机扫码后仍需输入 |
| `ownerEmail` | 扫码邮箱二因子的收件地址 |
| `emailTwoFactor` | 是否要求扫码后输入邮箱验证码 |
| `sessionDays` | 手机关闭浏览器后的登录保持天数；默认 7，范围 1-365 |
| `autoConnect` | 启动时是否连接 |
| `autoReconnect` | 断线后是否重连 |
| `domDiagnostics` | 是否允许已配对手机上报有界 DOM 几何诊断；默认关闭 |

## English

An independent DeepSeek Harness mobile-connectivity plugin. It defaults to `https://www.tokensfree.eu.cc` and keeps the URL editable in Settings. The desktop dials the public relay and sends a standard WebSocket heartbeat every 30 seconds to keep long browsing sessions connected, while a phone reaches the local Harness through a one-time pairing QR. HTTP and Harness application WebSocket traffic are end-to-end encrypted; the relay reads only the outer device-routing id and forwards ciphertext. The borderless phone login uses the official DeepSeek brand, supports Chinese/English, light/dark themes, a visible dark-theme grid, and in-page camera scanning. The scanner requests a high-resolution rear-camera stream and, when supported, lowers exposure, scores each available focus distance once, and locks the sharpest setting. Decoder selection follows browser capabilities: `qr-scanner` integrates native `BarcodeDetector`, while other browsers lazy-load ZXing-C++ WASM only after the user opens the camera. Both paths outline the detected QR, and the initial page downloads no decoder JavaScript or WASM. The phone confirms Service Worker control before consuming a one-time ticket. The desktop controls how many days a phone remains signed in after closing the browser; the default is seven days.

The package owns both halves of the capability: the Host provides the outbound tunnel and status route; the Client registers Mobile Bridge through the Harness `settings.section` Slot. The settings section edits the server URL, local port, optional passphrase, owner email, scan-time email second factor, and independent startup/reconnect policies, provides explicit connect/disconnect actions, and continuously displays the pairing QR with its six-character code. The passphrase is write-only: the page shows whether one is configured, an empty save preserves it, and entering a new value replaces it. Text and number fields save when editing finishes, while toggles save immediately after each change. Editing and toggle changes remain available during a save; connect, disconnect, and refresh wait for the latest draft to persist and do not run after a save failure. Persistence completes independently of the live connection status stream. The ticket refreshes before expiry or immediately after a successful pairing while a visible progress state replaces the stale QR. The paired-device list shows live state, IP address, first pairing, and last connection time, and the desktop can take one device offline without affecting the others or the next ticket; the revoked phone suspends all Harness tunnel requests and opens an offline notice with a scan-again action over the current Harness page; when no page is open, the next visit still shows the rescan page. No standalone HTML configuration panel is shipped. When another Harness instance takes over the same persisted desktop identity, the relay closes the old connection with `4001 desktop reconnected`; the old instance remains disconnected instead of competing for ownership, while phone requests and event streams continue through the new instance.

Remote DOM diagnostics are disabled by default and changing the setting does not rebuild the mobile tunnel. After enabling it, reopening an already paired phone page starts capture without another scan. Only a phone reaching Harness through an end-to-end encrypted tunnel emits a bounded geometry snapshot after page load and layout-affecting user events. A snapshot includes the viewport plus role, aria label, class names, data-attribute names, rectangles, and computed layout for visible interactive elements and a few ancestors; it excludes conversation text, input values, and URL queries. The Host keeps only the latest in-memory snapshot per device, projects its viewport, element count, and time in the paired-device row, and exposes the full data to local AI at `GET /mobile/bridge/diagnostics`. Disabling the setting stops capture and clears every snapshot immediately.

### Install

```sh
dsh plugin --profile web add @sparkelf/dsh-mobile-bridge@0.2.11
```

The package's `dsh.bundle` mounts the Host plugin and `dsh.client` loads the browser settings section. The phone injects only the application WebSocket facade; each Harness surface retains ownership of its responsive styles. Disabling or removing the bundle removes the routes, connection, and settings navigation entry together.

`0.2.10` registers and observes its namespace directly through the public Settings service and uses DSH alpha.2's slash Remote routes with the `payload.args` wire format; it has no runtime dependency on the Settings helper exports removed in alpha.2.

### Configuration

| Field | Meaning |
|---|---|
| `serverUrl` | HTTPS URL of the public mobile bridge server |
| `localPort` | Local Harness Web port |
| `userKey` | Optional passphrase; when set, the phone must enter it after scanning |
| `ownerEmail` | Inbox for scan-time email verification |
| `emailTwoFactor` | Require an email code after scanning |
| `sessionDays` | Days a phone remains signed in after closing the browser; defaults to 7, range 1-365 |
| `autoConnect` | Connect on startup |
| `autoReconnect` | Reconnect after disconnection |
| `domDiagnostics` | Allow bounded DOM geometry reports from paired phones; disabled by default |
