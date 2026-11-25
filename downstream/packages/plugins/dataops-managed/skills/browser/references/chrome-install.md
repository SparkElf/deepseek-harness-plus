> **已废弃（2026-11）：** 本参考描述的是旧 Chrome 扩展安装流程。现在请优先使用 [bridge.md](bridge.md) 的离线 Companion + Playwright MCP。保留本文仅用于排查旧环境。

# Browser Bridge Chrome Install

## Overview

Prepare a local browser for DataOps `browser` tool verification on Windows.

This skill covers the stable operator workflow for automated test-browser startup, unpacked extension refresh, backend bridge verification, and the fallback manual Google Chrome flow.

## Preconditions

- Work from the `dataops` repo on the same Windows machine that runs Chrome/Chromium.
- The snippets read the admin password from `DATAOPS_ADMIN_PASSWORD`; never paste a real credential into this file, a script, or a log.
- `references/scripts/start_test_browser_bridge.cjs` also needs `DATAOPS_PROJECTS_ROOT` pointing at the directory that contains the `dataops` checkout, and `DATAOPS_BROWSER_BRIDGE_PASSWORD` for the login.
- Reuse the current DataOps backend/frontend when available; do not restart them unless the user asks.
- Treat browser-side install as local-machine state. It is acceptable to open browser UI, but do not mutate unrelated browser profiles.
- Prefer an isolated Playwright Chromium profile for automated testing. Only use the user's Google Chrome profile when they explicitly ask to.

## Stable Workflow

### 1. Confirm backend truth first

Run these checks before touching the browser:

```powershell
Get-NetTCPConnection -State Listen -LocalPort 3000,3101 -ErrorAction SilentlyContinue |
  Select-Object LocalPort,OwningProcess,State
```

```powershell
@'
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
(async() => {
  const loginResponse = await fetch('https://127.0.0.1:3101/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account: 'admin', password: process.env.DATAOPS_ADMIN_PASSWORD }),
  });
  const loginPayload = await loginResponse.json();
  const toolsResponse = await fetch('https://127.0.0.1:3101/api/ai/tools', {
    headers: { Authorization: `Bearer ${loginPayload.accessToken}` },
  });
  const toolsPayload = await toolsResponse.json();
  const browserTool = toolsPayload.tools.find((tool) => tool.name === 'browser');
  console.log(JSON.stringify({
    browserBridge: browserTool?.browserBridge ?? null,
    dependencyPackage: browserTool?.dependencyPackage ?? null,
  }, null, 2));
})();
'@ | node -
```

Interpretation:

- `dependencyPackage.available = true` means backend package generation works.
- `browserBridge.connected = false` means Chrome-side install/connect work is still required.
- `workspaceStatus = RUNNING` is needed later for screenshot persistence, but not for extension install.

### 2. Download and unpack the extension package

Save the package and unpack it into a predictable local folder:

```powershell
@'
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
(async() => {
  const fs = require('fs');
  const loginResponse = await fetch('https://127.0.0.1:3101/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account: 'admin', password: process.env.DATAOPS_ADMIN_PASSWORD }),
  });
  const loginPayload = await loginResponse.json();
  const response = await fetch('https://127.0.0.1:3101/api/ai/tools/browser/dependency-package', {
    headers: { Authorization: `Bearer ${loginPayload.accessToken}` },
  });
  fs.writeFileSync('D:/project/projects/tmp-dataops-browser-bridge.zip', Buffer.from(await response.arrayBuffer()));
})();
'@ | node -
```

```powershell
if (Test-Path D:\project\projects\tmp-dataops-browser-bridge) {
  Remove-Item -LiteralPath D:\project\projects\tmp-dataops-browser-bridge -Recurse -Force
}
Expand-Archive -LiteralPath D:\project\projects\tmp-dataops-browser-bridge.zip `
  -DestinationPath D:\project\projects\tmp-dataops-browser-bridge -Force
```

The unpacked extension root is:

- `D:\project\projects\tmp-dataops-browser-bridge\extension`

### 3. Preferred automated path: launch the test browser

The preferred automated path is the Playwright Chromium browser that loads the latest unpacked Browser Bridge and connects it to the current backend automatically.

Run from this skill's base directory (the directory containing this `references/` folder):

```powershell
node .\references\scripts\start_test_browser_bridge.cjs --keep-open
```

Expected success signal:

- the script prints `backendBridge.connected = true`
- the script prints an `extensionId`, `workerUrl`, and non-empty `sessionId`
- backend `GET /api/ai/tools` shows `browser.browserBridge.connected = true`

What the script does:

- logs into backend with the current admin account
- reads `browser.dependencyPackage.version` from backend truth
- downloads and unpacks the latest Browser Bridge package when the local unpacked directory is missing or when the recorded package version no longer matches backend truth
- launches a persistent Playwright Chromium profile
- loads the unpacked extension with `--disable-extensions-except` and `--load-extension`
- opens the DataOps frontend, injects the login token into the page, opens the extension popup, fills the DataOps URL, and lets the extension auto-poll until it resolves the same-origin signed-in session and connects
- polls both popup state and backend state until the bridge is connected

Use this path for automated testing and repeatable local verification.

### 4. Fallback manual path: isolated Google Chrome

Use a dedicated profile and CDP port so manual Google Chrome validation does not collide with the user's normal Chrome windows:

```powershell
$chrome = 'C:\Users\Administrator\AppData\Local\Google\Chrome\Bin\chrome.exe'
$profile = 'D:\project\projects\tmp-chrome-browser-bridge-profile'
$extension = 'D:\project\projects\tmp-dataops-browser-bridge\extension'
New-Item -ItemType Directory -Force -Path $profile | Out-Null
Start-Process -FilePath $chrome -ArgumentList @(
  "--user-data-dir=$profile",
  '--disable-background-networking',
  '--remote-debugging-port=9999',
  "--disable-extensions-except=$extension",
  "--load-extension=$extension",
  '--no-first-run',
  '--no-default-browser-check',
  '--ignore-certificate-errors',
  '--new-window',
  'https://127.0.0.1:3000'
)
```

Confirm CDP is reachable:

```powershell
curl.exe http://127.0.0.1:9999/json/version
```

### 5. Manual install and reload method

Use this path only when the user explicitly wants Google Chrome itself rather than the automated test browser:

1. Open `chrome://extensions/`
2. Turn on `Developer mode`
3. Click `Load unpacked`
4. Select `D:\project\projects\tmp-dataops-browser-bridge\extension`
5. Open a logged-in DataOps tab in the same Chrome instance
6. Open the `DataOps Browser Bridge` popup
7. Enter the DataOps URL or paste a full DataOps page URL
8. Leave the popup open while it auto-polls for the same-origin signed-in session and connects; `Connect bridge` is only an immediate manual retry.

For an already installed unpacked extension after code changes:

1. Keep the unpacked folder path stable
2. Open `chrome://extensions/`
3. Use the existing extension card's `Reload`
4. Reopen the popup and wait for auto-connect if backend restarted

### 6. Current automation boundary

What automation can do reliably today:

- confirm backend Browser Bridge truth
- download and unpack the extension package
- launch Playwright Chromium with the extension and connect it automatically
- launch isolated Google Chrome with CDP
- open `chrome://extensions/`
- click `Load unpacked`
- detect the native folder-picker dialog and enumerate its controls

What remains unreliable and should be treated as a manual confirmation point:

- consumer Google Chrome on Windows does not provide a stable script-only path for registering the unpacked extension into `chrome.management`
- in project-local verification, Google Chrome logs `--disable-extensions-except is not allowed in Google Chrome, ignoring.`, so the automated path must target Playwright Chromium rather than the user's regular Google Chrome installation
- the native Windows Google Chrome folder picker for unpacked extensions does not reliably accept Win32 `WM_SETTEXT`, synthetic `SendKeys`, or repeated button invoke attempts in a way that registers the unpacked extension into `chrome.management`
- in the current verified environment, Google Chrome can still expose `chrome-extension://.../popup.html` targets that resolve to `chrome-error://chromewebdata/ ERR_FILE_NOT_FOUND`; do not treat those targets as proof the extension is installed

Therefore the stable workflow is:

- use Playwright Chromium for any automated Browser Bridge testing
- reserve Google Chrome for manual operator validation only
- if Google Chrome must be used, let the operator manually confirm the `extension/` directory in the folder picker and then continue with popup import/connect validation

## Verification

### Automated test-browser verification

After `start_test_browser_bridge.cjs`, verify backend state directly:

```powershell
cd dataops
node .\references\scripts\check_browser_bridge_status.js
```

Success condition:

- `browserBridge.connected = true`
- `activeSessionCount >= 1`

### Manual Google Chrome verification

After manual confirmation, verify the extension is real rather than trusting stale popup targets:

```powershell
@'
const path = require('path');
const { createRequire } = require('module');
const frontendRequire = createRequire(path.resolve('d:/project/projects/dataops/frontend/package.json'));
const { chromium } = frontendRequire('playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9999');
  const context = browser.contexts()[0];
  const page = await context.newPage();
  await page.goto('chrome://extensions/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  const result = await page.evaluate(() => new Promise((resolve, reject) => {
    chrome.management.getAll((items) => {
      const err = chrome.runtime?.lastError?.message;
      if (err) return reject(new Error(err));
      resolve(items.map((item) => ({
        id: item.id,
        name: item.name,
        enabled: item.enabled,
        installType: item.installType,
        type: item.type,
      })));
    });
  }));
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
})();
'@ | node -
```

Success condition:

- `chrome.management.getAll()` contains `DataOps Browser Bridge`

Failure condition:

- `getAll()` stays empty or does not include the Browser Bridge entry
- any `chrome-extension://.../popup.html` target still renders `chrome-error://chromewebdata/ ERR_FILE_NOT_FOUND`

### Backend-side verification

After popup auto-connect, backend must flip to connected:

```powershell
@'
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
(async() => {
  const loginResponse = await fetch('https://127.0.0.1:3101/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account: 'admin', password: process.env.DATAOPS_ADMIN_PASSWORD }),
  });
  const loginPayload = await loginResponse.json();
  const toolsResponse = await fetch('https://127.0.0.1:3101/api/ai/tools', {
    headers: { Authorization: `Bearer ${loginPayload.accessToken}` },
  });
  const toolsPayload = await toolsResponse.json();
  const browserTool = toolsPayload.tools.find((tool) => tool.name === 'browser');
  console.log(JSON.stringify(browserTool?.browserBridge ?? null, null, 2));
})();
'@ | node -
```

Success condition:

- `connected = true`
- `activeSessionCount >= 1`

## Recovery Notes

- If backend still shows `Bridge required`, reopen the popup in the same browser instance and wait for auto-connect.
- If `start_test_browser_bridge.cjs` fails before backend flips to connected, rerun it with the latest unpacked package in place and read the emitted popup/backend state rather than switching immediately to the manual Chrome path.
- If `chrome.management.getAll()` does not show `DataOps Browser Bridge` in Google Chrome, do not keep retrying synthetic text-entry against the folder picker. Reopen `chrome://extensions/` and perform the final folder selection manually.
- If Chrome is already running on the default profile, prefer the isolated profile/CDP launch above instead of reusing the default profile for automation.

## Cleanup

Only remove temporary artifacts that were created for isolated automation:

```powershell
Get-CimInstance Win32_Process -Filter \"Name = 'chrome.exe'\" |
  Where-Object { $_.CommandLine -like '*tmp-chrome-browser-bridge-profile*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

```powershell
Remove-Item D:\project\projects\tmp-dataops-browser-bridge.zip -Force -ErrorAction SilentlyContinue
Remove-Item D:\project\projects\tmp-dataops-browser-bridge -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item D:\project\projects\tmp-chrome-browser-bridge-profile -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item D:\project\projects\tmp-chrome-browser-bridge-profile-2 -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item D:\project\projects\tmp-playwright-browser-bridge-profile -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item D:\project\projects\tmp-chrome-browser-bridge-profile-log -Recurse -Force -ErrorAction SilentlyContinue
```
