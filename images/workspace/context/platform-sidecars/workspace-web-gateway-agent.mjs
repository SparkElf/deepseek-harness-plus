import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { connect as connectTcp } from 'node:net';
import { io } from 'socket.io-client';
import { z } from 'zod';

const {
  WORKSPACE_WEB_GATEWAY_AGENT_NAMESPACE,
  WORKSPACE_WEB_GATEWAY_AGENT_SOCKET_PATH,
  WORKSPACE_WEB_GATEWAY_HTTP_CHUNK_BYTES,
  WORKSPACE_WEB_GATEWAY_PROTOCOL_VERSION,
  WORKSPACE_WEB_GATEWAY_SOCKET_CHUNK_BYTES,
  createWorkspaceWebGatewayProtocolSchemas,
} = await import('file:///packages/workspace-web-gateway-protocol/index.js');
const { serverAgentMessageSchema } = createWorkspaceWebGatewayProtocolSchemas(z);
const gatewayAckSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), message: z.string().min(1).max(4096) }),
]);
const GATEWAY_ACK_TIMEOUT_MS = 30_000;

const agentInstanceId = randomUUID();
const userId = process.env.DATAOPS_AI_WORKSPACE_USER_ID?.trim();
const tokenFile = process.env.DATAOPS_AI_WORKSPACE_INTERNAL_TOKEN_FILE?.trim();
const token = tokenFile ? readFileSync(tokenFile, 'utf8').trim() : '';
const backendBaseUrl = process.env.DATAOPS_AI_WORKSPACE_BACKEND_BASE_URL?.trim();
const dshHost = process.env.DATAOPS_DSH_HOST?.trim() || '127.0.0.1';
const dshPort = Number(process.env.DATAOPS_DSH_PORT?.trim() || '3080');

if (!userId || !token || !backendBaseUrl) {
  throw new Error('Workspace Web Gateway agent requires workspace user, token, and backend base URL');
}
if (dshHost !== '127.0.0.1' || !Number.isInteger(dshPort) || dshPort < 1 || dshPort > 65535) {
  throw new Error('Workspace Web Gateway agent only targets the managed loopback DSH service');
}

const localAuthority = `${dshHost}:${dshPort}`;
const httpRequests = new Map();
const webSockets = new Map();


/*
 * The managed DSH refuses every route until the browser presents the signed cookie it issues in
 * exchange for the launch token printed on its startup line. Nothing in this deployment performs
 * that exchange: the launcher runs with --no-open, so the token only reaches the log, and the
 * browser enters through the DataOps iframe rather than that URL. The agent forwards DSH requests
 * under its own loopback authority, so it exchanges the token once here and attaches the cookie to
 * everything it forwards. Without this every request and upgrade answers 401 and the page retries
 * forever.
 */
const dshHome = process.env.DATAOPS_DSH_HOME?.trim() || '/workspace/.dataops/dsh';
const dshLogPath = `${dshHome}/logs/web.log`;
let browserSession;

/**
 * Read the launch token DSH printed last.
 *
 * The token is minted per process, so its value identifies the running DSH instance: a change
 * means the previous cookie was issued by a process that no longer exists.
 * @returns the newest token, or undefined when the log carries none yet.
 */
const readLaunchToken = () => {
  let text;
  try {
    text = readFileSync(dshLogPath, 'utf8');
  } catch (error) {
    logCaught('workspace-web-gateway-agent.dsh-log-unreadable', error);
    return undefined;
  }
  const matches = [...text.matchAll(/dsh web: http[^\s]*[?&]token=([A-Za-z0-9_-]+)/gu)];
  return matches.length === 0 ? undefined : matches[matches.length - 1][1];
};

/**
 * Exchange one launch token for the browser cookie, under the authority this agent forwards with.
 * @param launchToken - token from the current DSH process.
 * @returns the `name=value` cookie pair, or undefined when DSH issues none.
 */
const exchangeBrowserSession = async (launchToken) => {
  const cookies = await new Promise((resolve, reject) => {
    const req = httpRequest({
      host: dshHost, port: dshPort, method: 'GET',
      path: `/?token=${launchToken}`, headers: { host: localAuthority, connection: 'close' },
    }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.headers['set-cookie'] ?? []));
    });
    req.on('error', reject);
    req.end();
  });
  for (const raw of Array.isArray(cookies) ? cookies : [cookies]) {
    const pair = String(raw).split(';')[0].trim();
    if (pair.startsWith('dsh-auth-')) return pair;
  }
  return undefined;
};

/**
 * The browser cookie for the current DSH process, re-exchanged whenever that process changes.
 * @returns the `name=value` cookie pair, or undefined when DSH has not published a token yet.
 */
const browserSessionCookie = async () => {
  const launchToken = readLaunchToken();
  if (launchToken === undefined) return undefined;
  if (browserSession !== undefined && browserSession.token === launchToken) return browserSession.cookie;
  const cookie = await exchangeBrowserSession(launchToken);
  browserSession = cookie === undefined ? undefined : { token: launchToken, cookie };
  return cookie;
};

/**
 * Attach the DSH browser cookie to one outbound header set.
 * @param headers - mutable header map already addressed to the loopback authority.
 */
const withBrowserSession = async (headers) => {
  const cookie = await browserSessionCookie();
  if (cookie !== undefined) headers.cookie = cookie;
  return headers;
};

const isNativeDshPath = (value) =>
  typeof value === 'string'
  && value.startsWith('/')
  && !value.startsWith('//')
  && URL.canParse(value, 'http://workspace.local');

const pairsToLocalHeaders = (pairs) => {
  const headers = {};
  for (const [rawName, value] of pairs) {
    const name = rawName.toLowerCase();
    if (headers[name] === undefined) headers[name] = value;
    else headers[name] = `${headers[name]}, ${value}`;
  }
  headers.host = localAuthority;
  return headers;
};

const responseHeaderPairs = (rawHeaders) => {
  const pairs = [];
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const name = rawHeaders[index].toLowerCase();
    const value = rawHeaders[index + 1];
    if (!name) continue;
    pairs.push([name, value]);
  }
  return pairs;
};

const logCaught = (event, error) => {
  const diagnostic = error instanceof Error ? error : new Error(String(error));
  console.error(`[${event}] ${diagnostic.stack ?? diagnostic.message}`);
};

const errorRecord = (error, fallbackCode) => ({
  code: error && typeof error === 'object' && typeof error.code === 'string'
    ? error.code
    : fallbackCode,
  message: error instanceof Error ? error.message : String(error),
});

const socket = io(`${backendBaseUrl.replace(/\/+$/u, '')}${WORKSPACE_WEB_GATEWAY_AGENT_NAMESPACE}`, {
  path: WORKSPACE_WEB_GATEWAY_AGENT_SOCKET_PATH,
  transports: ['websocket'],
  auth: { userId, token, agentInstanceId, protocolVersion: WORKSPACE_WEB_GATEWAY_PROTOCOL_VERSION },
  reconnection: true,
});

const emitWithAck = async (message) => {
  if (!socket.connected) throw new Error('workspace web gateway transport is disconnected');
  const ack = gatewayAckSchema.parse(
    await socket.timeout(GATEWAY_ACK_TIMEOUT_MS).emitWithAck('gateway-message', message),
  );
  if (!ack.ok) throw new Error(ack.message);
};

const writeWithDrain = async (stream, data) => {
  if (stream.destroyed || stream.writableEnded) throw new Error('local gateway stream is closed');
  if (stream.write(data)) return;
  await once(stream, 'drain');
};

const sendHttpError = async (requestId, error) => {
  logCaught('workspace-web-gateway-agent.http-failed', error);
  const diagnostic = errorRecord(error, 'DSH_HTTP_TUNNEL_FAILED');
  try {
    await emitWithAck({ type: 'http_error', requestId, ...diagnostic });
  } catch (emitError) {
    logCaught('workspace-web-gateway-agent.http-error-ack-failed', emitError);
  }
};

const emitHttpBytes = async (requestId, bytes, nextSequence) => {
  for (let offset = 0; offset < bytes.byteLength; offset += WORKSPACE_WEB_GATEWAY_HTTP_CHUNK_BYTES) {
    const data = bytes.subarray(offset, Math.min(bytes.byteLength, offset + WORKSPACE_WEB_GATEWAY_HTTP_CHUNK_BYTES));
    nextSequence.value += 1;
    await emitWithAck({ type: 'http_response_chunk', requestId, sequence: nextSequence.value, data });
  }
};

const pipeHttpResponse = async (requestId, response) => {
  await emitWithAck({
    type: 'http_response_start',
    requestId,
    status: response.statusCode,
    headers: responseHeaderPairs(response.rawHeaders),
  });
  const sequence = { value: 0 };
  for await (const value of response) {
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
    await emitHttpBytes(requestId, data, sequence);
  }
  await emitWithAck({ type: 'http_response_end', requestId });
};

const startHttpRequest = async (message) => {
  if (!isNativeDshPath(message.path)) throw new Error('HTTP request is not a native DSH root path');
  if (httpRequests.has(message.requestId) || webSockets.has(message.requestId)) {
    throw new Error(`duplicate gateway request ${message.requestId}`);
  }
  const headers = await withBrowserSession(pairsToLocalHeaders(message.headers));
  const request = httpRequest({
    host: dshHost,
    port: dshPort,
    method: message.method,
    path: message.path,
    headers,
  });
  const transaction = { request, responseTask: null };
  httpRequests.set(message.requestId, transaction);
  request.on('response', (response) => {
    transaction.responseTask = pipeHttpResponse(message.requestId, response)
      .catch((error) => sendHttpError(message.requestId, error))
      .finally(() => httpRequests.delete(message.requestId));
  });
  request.on('error', (error) => {
    if (!httpRequests.has(message.requestId)) return;
    void sendHttpError(message.requestId, error).finally(() => httpRequests.delete(message.requestId));
  });
};

const writeHttpChunk = async (message) => {
  const transaction = httpRequests.get(message.requestId);
  if (!transaction) throw new Error(`unknown HTTP request ${message.requestId}`);
  await writeWithDrain(transaction.request, Buffer.from(message.data));
};

const endHttpRequest = async (requestId) => {
  const transaction = httpRequests.get(requestId);
  if (!transaction) throw new Error(`unknown HTTP request ${requestId}`);
  await new Promise((resolve, reject) => {
    transaction.request.end(resolve);
    transaction.request.once('error', reject);
  });
};

const abortHttpRequest = (requestId, reason) => {
  const transaction = httpRequests.get(requestId);
  if (!transaction) return;
  httpRequests.delete(requestId);
  transaction.request.destroy(new Error(reason));
};

const serializeUpgradeRequest = async (message) => {
  const headers = await withBrowserSession(pairsToLocalHeaders(message.headers));
  headers.connection = 'Upgrade';
  headers.upgrade = 'websocket';
  const lines = [`GET ${message.path} HTTP/1.1`];
  for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
  return Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'utf8');
};

const emitSocketBytes = async (requestId, bytes, nextSequence) => {
  for (let offset = 0; offset < bytes.byteLength; offset += WORKSPACE_WEB_GATEWAY_SOCKET_CHUNK_BYTES) {
    const data = bytes.subarray(offset, Math.min(bytes.byteLength, offset + WORKSPACE_WEB_GATEWAY_SOCKET_CHUNK_BYTES));
    nextSequence.value += 1;
    await emitWithAck({ type: 'ws_chunk_to_server', requestId, sequence: nextSequence.value, data });
  }
};

const readWebSocket = async (message, transaction) => {
  const upstream = transaction.upstream;
  const sequence = { value: 0 };
  try {
    await transaction.upgradeWritten;
    let handshake = Buffer.alloc(0);
    let opened = false;
    for await (const value of upstream) {
      const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (!opened) {
        handshake = Buffer.concat([handshake, data]);
        if (handshake.byteLength > 64 * 1024) {
          throw new Error('DSH WebSocket upgrade response exceeded 64 KiB');
        }
        const boundary = handshake.indexOf('\r\n\r\n');
        if (boundary === -1) continue;
        const responseHead = handshake.subarray(0, boundary + 4);
        const lineEnd = responseHead.indexOf('\r\n');
        const statusLine = responseHead.toString('latin1', 0, lineEnd === -1 ? responseHead.length : lineEnd);
        if (!/^HTTP\/1\.[01] 101(?: |$)/u.test(statusLine)) {
          throw new Error(`DSH WebSocket upgrade rejected: ${statusLine || 'invalid response'}`);
        }
        await emitWithAck({ type: 'ws_opened', requestId: message.requestId, responseHead });
        opened = true;
        const remainder = handshake.subarray(boundary + 4);
        handshake = Buffer.alloc(0);
        if (remainder.byteLength) await emitSocketBytes(message.requestId, remainder, sequence);
        continue;
      }
      await emitSocketBytes(message.requestId, data, sequence);
    }
    if (socket.connected) {
      try {
        await emitWithAck({
          type: 'ws_closed', requestId: message.requestId, reason: 'local DSH socket closed',
        });
      } catch (emitError) {
        logCaught('workspace-web-gateway-agent.ws-close-ack-failed', emitError);
      }
    }
  } catch (error) {
    logCaught('workspace-web-gateway-agent.websocket-failed', error);
    if (socket.connected) {
      const diagnostic = errorRecord(error, 'DSH_WEBSOCKET_TUNNEL_FAILED');
      try {
        await emitWithAck({ type: 'ws_error', requestId: message.requestId, ...diagnostic });
      } catch (emitError) {
        logCaught('workspace-web-gateway-agent.ws-error-ack-failed', emitError);
      }
    }
  } finally {
    webSockets.delete(message.requestId);
    upstream.destroy();
  }
};

const startWebSocket = async (message) => {
  if (!isNativeDshPath(message.path)) throw new Error('WebSocket request is not a native DSH root path');
  if (httpRequests.has(message.requestId) || webSockets.has(message.requestId)) {
    throw new Error(`duplicate gateway request ${message.requestId}`);
  }
  const upstream = connectTcp({ host: dshHost, port: dshPort });
  const upgradeWritten = (async () => {
    await once(upstream, 'connect');
    await writeWithDrain(upstream, await serializeUpgradeRequest(message));
    if (message.initialData?.byteLength) {
      await writeWithDrain(upstream, Buffer.from(message.initialData));
    }
  })();
  const transaction = { upstream, upgradeWritten };
  webSockets.set(message.requestId, transaction);
  void readWebSocket(message, transaction);
  await upgradeWritten;
};

const forwardWebSocketChunk = async (message) => {
  const transaction = webSockets.get(message.requestId);
  if (!transaction) throw new Error(`unknown WebSocket request ${message.requestId}`);
  await transaction.upgradeWritten;
  await writeWithDrain(transaction.upstream, Buffer.from(message.data));
};

const closeWebSocket = (requestId) => {
  const transaction = webSockets.get(requestId);
  if (!transaction) return;
  webSockets.delete(requestId);
  transaction.upstream.destroy();
};

const handleServerMessage = async (rawMessage) => {
  const message = serverAgentMessageSchema.parse(rawMessage);
  switch (message.type) {
    case 'http_start': await startHttpRequest(message); break;
    case 'http_chunk': await writeHttpChunk(message); break;
    case 'http_end': await endHttpRequest(message.requestId); break;
    case 'http_abort': abortHttpRequest(message.requestId, message.reason); break;
    case 'ws_open': await startWebSocket(message); break;
    case 'ws_chunk_to_agent': await forwardWebSocketChunk(message); break;
    case 'ws_close_to_agent': closeWebSocket(message.requestId); break;
  }
};

socket.on('gateway-message', (message, acknowledge) => {
  void handleServerMessage(message).then(
    () => acknowledge?.({ ok: true }),
    (error) => {
      const diagnostic = error instanceof Error ? error : new Error(String(error));
      logCaught('workspace-web-gateway-agent.server-message-failed', diagnostic);
      acknowledge?.({ ok: false, message: diagnostic.message });
    },
  );
});

const closeAllLocalTransactions = () => {
  for (const transaction of httpRequests.values()) transaction.request.destroy(new Error('gateway disconnected'));
  httpRequests.clear();
  for (const transaction of webSockets.values()) transaction.upstream.destroy();
  webSockets.clear();
};

socket.on('disconnect', closeAllLocalTransactions);
socket.on('connect_error', (error) => {
  logCaught('workspace-web-gateway-agent.connect-failed', error);
});
process.once('SIGTERM', () => {
  closeAllLocalTransactions();
  socket.close();
  process.exit(0);
});
process.once('SIGINT', () => {
  closeAllLocalTransactions();
  socket.close();
  process.exit(0);
});
