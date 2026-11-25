process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { createRequire } = require('module');

const repoRoot = process.env.DATAOPS_PROJECTS_ROOT;
if (!repoRoot) {
  throw new Error('set DATAOPS_PROJECTS_ROOT to the directory containing the dataops checkout');
}
const frontendRequire = createRequire(path.resolve(repoRoot, 'dataops/frontend/package.json'));
const { chromium } = frontendRequire('playwright');

const args = new Set(process.argv.slice(2));
const keepOpen = args.has('--keep-open');

const backendOrigin = process.env.DATAOPS_BROWSER_BRIDGE_BACKEND_ORIGIN || 'https://127.0.0.1:3101';
const frontendOrigin = process.env.DATAOPS_BROWSER_BRIDGE_FRONTEND_ORIGIN || 'https://127.0.0.1:3000';
const account = process.env.DATAOPS_BROWSER_BRIDGE_ACCOUNT || 'admin';
const password = process.env.DATAOPS_BROWSER_BRIDGE_PASSWORD;
if (!password) {
  throw new Error('set DATAOPS_BROWSER_BRIDGE_PASSWORD before running this script');
}
const profileDir = process.env.DATAOPS_BROWSER_BRIDGE_PROFILE_DIR || path.resolve(repoRoot, 'tmp-playwright-browser-bridge-profile');
const packageZipPath = path.resolve(repoRoot, 'tmp-dataops-browser-bridge.zip');
const packageDir = path.resolve(repoRoot, 'tmp-dataops-browser-bridge');
const extensionDir = path.resolve(packageDir, 'extension');
const packageVersionPath = path.resolve(packageDir, '.package-version.txt');
const bridgeOrigin = process.env.DATAOPS_BROWSER_BRIDGE_SITE_ORIGIN || backendOrigin;

async function login() {
  const response = await fetch(`${backendOrigin}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account, password }),
  });
  if (!response.ok) {
    throw new Error(`Login failed: ${response.status}`);
  }
  return response.json();
}

async function fetchBrowserTool(accessToken) {
  const response = await fetch(`${backendOrigin}/api/ai/tools`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`GET /api/ai/tools failed: ${response.status}`);
  }
  const payload = await response.json();
  return payload.tools.find((tool) => tool.name === 'browser') || null;
}

async function ensureExtensionPackage(accessToken, browserTool) {
  const expectedVersion = browserTool?.dependencyPackage?.version || null;
  const manifestPath = path.join(extensionDir, 'manifest.json');
  const currentVersion = fs.existsSync(packageVersionPath)
    ? fs.readFileSync(packageVersionPath, 'utf8').trim()
    : null;
  if (fs.existsSync(manifestPath) && expectedVersion && currentVersion === expectedVersion) {
    return;
  }
  const response = await fetch(`${backendOrigin}/api/ai/tools/browser/dependency-package`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`GET /api/ai/tools/browser/dependency-package failed: ${response.status}`);
  }
  fs.writeFileSync(packageZipPath, Buffer.from(await response.arrayBuffer()));
  if (fs.existsSync(packageDir)) {
    fs.rmSync(packageDir, { recursive: true, force: true });
  }
  execFileSync('powershell', [
    '-NoProfile',
    '-Command',
    `Expand-Archive -LiteralPath '${packageZipPath}' -DestinationPath '${packageDir}' -Force`,
  ], { stdio: 'pipe' });
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Unpacked extension manifest not found at ${manifestPath}`);
  }
  if (expectedVersion) {
    fs.writeFileSync(packageVersionPath, `${expectedVersion}\n`);
  }
}

async function getPopupState(popup) {
  return popup.evaluate(() => new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'browser_bridge:get_state' }, (response) => {
      resolve({ response, lastError: chrome.runtime?.lastError?.message || null });
    });
  }));
}

async function ensurePopupPage(context, extensionId, existingPopup = null) {
  const usablePopup =
    existingPopup
    && !existingPopup.isClosed()
    && existingPopup.url().startsWith(`chrome-extension://${extensionId}/`);
  if (usablePopup) {
    return usablePopup;
  }
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  return popup;
}

async function waitForConnected(popup, accessToken) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    let popupState;
    try {
      popupState = await getPopupState(popup);
    } catch (error) {
      if (String(error).includes('Execution context was destroyed')) {
        throw Object.assign(new Error('POPUP_CONTEXT_DESTROYED'), { cause: error });
      }
      throw error;
    }
    const browserTool = await fetchBrowserTool(accessToken);
    if (popupState.response?.state?.connected === true && browserTool?.browserBridge?.connected === true) {
      return { popupState, browserTool };
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('Timed out waiting for Browser Bridge to connect.');
}

async function main() {
  const loginPayload = await login();
  const browserToolBeforeLaunch = await fetchBrowserTool(loginPayload.accessToken);
  await ensureExtensionPackage(loginPayload.accessToken, browserToolBeforeLaunch);

  if (fs.existsSync(profileDir)) {
    fs.rmSync(profileDir, { recursive: true, force: true });
  }

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    ignoreHTTPSErrors: true,
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--ignore-certificate-errors',
      '--allow-insecure-localhost',
    ],
  });

  const closeContext = async () => {
    try {
      await context.close();
    } catch {}
  };
  process.on('SIGINT', async () => {
    await closeContext();
    process.exit(130);
  });
  process.on('SIGTERM', async () => {
    await closeContext();
    process.exit(143);
  });

  const page = await context.newPage();
  await page.goto(bridgeOrigin, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.evaluate((token) => localStorage.setItem('dataops_auth_token', token), loginPayload.accessToken);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });

  let worker = context.serviceWorkers().find((item) => item.url().startsWith('chrome-extension://'));
  if (!worker) {
    worker = await context.waitForEvent('serviceworker', {
      timeout: 60000,
      predicate: (item) => item.url().startsWith('chrome-extension://'),
    });
  }
  const extensionId = new URL(worker.url()).host;

  let popup = await ensurePopupPage(context, extensionId);
  popup.on('console', (message) => {
    console.log(`[popup:console:${message.type()}] ${message.text()}`);
  });
  popup.on('pageerror', (error) => {
    console.log(`[popup:pageerror] ${error.message}`);
  });
  popup.on('close', () => {
    console.log('[popup:close]');
  });
  await popup.locator('#serverOrigin').fill(bridgeOrigin);

  let popupState;
  let browserTool;
  try {
    ({ popupState, browserTool } = await waitForConnected(popup, loginPayload.accessToken));
  } catch (error) {
    if (error?.message === 'POPUP_CONTEXT_DESTROYED') {
      popup = await ensurePopupPage(context, extensionId, popup);
      popup.on('console', (message) => {
        console.log(`[popup:console:${message.type()}] ${message.text()}`);
      });
      popup.on('pageerror', (pageError) => {
        console.log(`[popup:pageerror] ${pageError.message}`);
      });
      popup.on('close', () => {
        console.log('[popup:close]');
      });
      ({ popupState, browserTool } = await waitForConnected(popup, loginPayload.accessToken));
    } else {
      throw error;
    }
  }

  const payload = {
    ok: true,
    frontendOrigin,
    backendOrigin,
    bridgeOrigin,
    profileDir,
    extensionDir,
    extensionId,
    workerUrl: worker.url(),
    sessionId: popupState.response?.state?.sessionId || null,
    popupState,
    backendBridge: browserTool?.browserBridge ?? null,
  };

  console.log(JSON.stringify(payload, null, 2));

  if (keepOpen) {
    await new Promise(() => {});
  } else {
    await closeContext();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: String(error),
    stack: error && error.stack ? error.stack : null,
  }, null, 2));
  process.exit(1);
});
