/**
 * Third-party SDK gateway: expose one workspace's DSH session control to a caller
 * that reached this container directly, without a DataOps round trip per frame.
 *
 * A caller authenticates once against DataOps and receives this container's address
 * plus the workspace owner's internal token. Every request here re-derives the
 * expected token from the container's own copy of the signing secret and compares it
 * in constant time, so no call leaves the container to authorize.
 */
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

const DSH_HOST = process.env.DATAOPS_DSH_HOST ?? '127.0.0.1';
const DSH_PORT = Number(process.env.DATAOPS_DSH_PORT ?? '3080');
const PORT = Number(process.env.DATAOPS_WORKSPACE_SDK_PORT ?? '43118');
const HOST = process.env.DATAOPS_WORKSPACE_SDK_HOST ?? '0.0.0.0';
const USER_ID = String(process.env.DATAOPS_AI_WORKSPACE_USER_ID ?? '').trim();
/**
 * The workspace owner's token, minted by DataOps when this container was created.
 * Comparing against this copy is what lets a request be authorized without a call
 * back to DataOps: the token is an HMAC over the owner id, so a caller cannot forge
 * one for a different workspace.
 */
const OWNER_TOKEN_FILE = String(process.env.DATAOPS_AI_WORKSPACE_INTERNAL_TOKEN_FILE ?? '').trim();
const OWNER_TOKEN = OWNER_TOKEN_FILE ? readFileSync(OWNER_TOKEN_FILE, 'utf8').trim() : '';
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** DSH loops back here; the connection trust fence admits a loopback authority. */
const DSH_ORIGIN = 'http://127.0.0.1:' + String(DSH_PORT);

/**
 * Managed DSH 0.2.3 refuses /api routes until the caller presents the signed cookie issued
 * in exchange for the launch token printed on its startup line. The caller authenticates to
 * the SDK gateway with the owner token, but DSH still needs its own browser session; exchange
 * the launch token once and attach that cookie to every proxied HTTP request and WS upgrade.
 */
const DSH_HOME = String(process.env.DATAOPS_DSH_HOME ?? '/workspace/.dataops/dsh').trim() || '/workspace/.dataops/dsh';
const DSH_LOG_PATH = DSH_HOME + '/logs/web.log';
const DSH_AUTHORITY = '127.0.0.1:' + String(DSH_PORT);
let dshBrowserSession;

function readDshLaunchToken() {
  let text;
  try {
    text = readFileSync(DSH_LOG_PATH, 'utf8');
  } catch (error) {
    console.error('[workspace-sdk] DSH log unreadable: ' + error.message);
    return undefined;
  }
  const matches = [...text.matchAll(/dsh web: http[^\s]*[?&]token=([A-Za-z0-9_-]+)/gu)];
  return matches.length === 0 ? undefined : matches[matches.length - 1][1];
}

function exchangeDshBrowserSession(launchToken) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: DSH_HOST,
      port: DSH_PORT,
      method: 'GET',
      path: '/?token=' + encodeURIComponent(launchToken),
      headers: { host: DSH_AUTHORITY, connection: 'close' },
    }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.headers['set-cookie'] ?? []));
    });
    request.on('error', reject);
    request.end();
  });
}

async function dshBrowserCookie() {
  const launchToken = readDshLaunchToken();
  if (launchToken === undefined) return undefined;
  if (dshBrowserSession !== undefined && dshBrowserSession.token === launchToken) {
    return dshBrowserSession.cookie;
  }
  const cookies = await exchangeDshBrowserSession(launchToken);
  for (const raw of Array.isArray(cookies) ? cookies : [cookies]) {
    const pair = String(raw).split(';')[0].trim();
    if (pair.startsWith('dsh-auth-')) {
      dshBrowserSession = { token: launchToken, cookie: pair };
      return pair;
    }
  }
  return undefined;
}

async function withDshCookie(headers) {
  try {
    const cookie = await dshBrowserCookie();
    if (cookie !== undefined) headers.cookie = cookie;
  } catch (error) {
    console.error('[workspace-sdk] DSH cookie exchange failed: ' + error.message);
  }
  return headers;
}

/** True when the caller presented this workspace owner's token. */
function authorized(header) {
  if (USER_ID === '' || OWNER_TOKEN === '') return false;
  const provided = String(header ?? '').trim();
  if (provided === '') return false;
  const expected = Buffer.from(OWNER_TOKEN, 'utf8');
  const actual = Buffer.from(provided, 'utf8');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function sendJson(response, status, body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
  });
  response.end(payload);
}

function sendError(response, status, code, message) {
  sendJson(response, status, { ok: false, code, message });
}

/**
 * Forward one unary Remote call to DSH and relay its answer.
 * @param request - the caller's request carrying the JSON payload.
 * @param response - the caller's response.
 */
function forwardUnary(request, response) {
  const chunks = [];
  let size = 0;
  request.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      sendError(response, 413, 'OUTPUT_TOO_LARGE', 'request body too large');
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on('end', async () => {
    if (response.writableEnded) return;
    const body = Buffer.concat(chunks);
    const headers = await withDshCookie({
      'content-type': request.headers['content-type'] ?? 'application/json',
      'content-length': String(body.length),
      origin: DSH_ORIGIN,
      host: DSH_AUTHORITY,
    });
    const upstream = httpRequest(
      { host: DSH_HOST, port: DSH_PORT, path: request.url, method: 'POST', headers },
      (answer) => {
        response.writeHead(answer.statusCode ?? 502, { 'content-type': answer.headers['content-type'] ?? 'application/json' });
        answer.pipe(response);
      },
    );
    upstream.on('error', (error) => {
      if (!response.headersSent) sendError(response, 502, 'DSH_UNREACHABLE', String(error.message));
    });
    upstream.end(body);
  });
}

const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    sendJson(response, 200, { ok: true, status: 'ready', userId: USER_ID });
    return;
  }
  if (!authorized(request.headers['x-dataops-workspace-internal-token'])) {
    sendError(response, 401, 'UNAUTHORIZED', 'missing or invalid workspace token');
    return;
  }
  if (request.method === 'POST' && typeof request.url === 'string' && request.url.startsWith('/api/')) {
    forwardUnary(request, response);
    return;
  }
  sendError(response, 404, 'PATH_NOT_FOUND', 'unknown endpoint: ' + String(request.url));
});

const streams = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  if (!authorized(request.headers['x-dataops-workspace-internal-token'])) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
    return;
  }
  if (request.url !== '/api/remote.mux') {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
    return;
  }
  streams.handleUpgrade(request, socket, head, async (caller) => {
    let headers;
    try {
      headers = await withDshCookie({ origin: DSH_ORIGIN, host: DSH_AUTHORITY });
    } catch (error) {
      console.error('[workspace-sdk] DSH cookie exchange failed for websocket: ' + error.message);
      caller.close(1011, 'DSH authentication unavailable');
      return;
    }
    const upstream = new WebSocket('ws://' + DSH_HOST + ':' + String(DSH_PORT) + '/api/remote.mux', { headers });
    const pending = [];
    upstream.on('open', () => {
      for (const item of pending) upstream.send(item);
      pending.length = 0;
    });
    caller.on('message', (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
      else if (upstream.readyState === WebSocket.CONNECTING) pending.push(data);
    });
    upstream.on('message', (data, isBinary) => {
      if (caller.readyState === WebSocket.OPEN) caller.send(data, { binary: isBinary });
    });
    const stop = () => {
      if (caller.readyState === WebSocket.OPEN) caller.close();
      if (upstream.readyState === WebSocket.OPEN) upstream.close();
    };
    caller.on('close', stop);
    upstream.on('close', stop);
    caller.on('error', stop);
    upstream.on('error', (error) => {
      console.error('[workspace-sdk] upstream failed', error.message);
      if (caller.readyState === WebSocket.OPEN) caller.close(1011, 'upstream failed');
    });
  });
});

/**
 * Resolves once the listener owns PORT. A port conflict is reported to the combined
 * gateway instead of becoming an unhandled 'error' event that would also kill the web
 * tunnel. In split mode the supervisor sees this process exit after the failed listen and
 * restarts it; the combined gateway treats the rejection as a degraded SDK only.
 */
export const sdkReady = new Promise((resolve, reject) => {
  server.on('error', (error) => {
    console.error('[workspace-sdk] listener failed: ' + error.message);
    reject(error);
  });
  server.listen(PORT, HOST, () => {
    console.log('[workspace-sdk] listening on ' + HOST + ':' + String(PORT) + ' for workspace owner ' + USER_ID);
    resolve();
  });
});
sdkReady.catch((error) => {
  console.error('[workspace-sdk] not ready: ' + (error instanceof Error ? error.message : String(error)));
});
