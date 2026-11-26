export const WORKSPACE_WEB_GATEWAY_PROTOCOL_VERSION = 1;
export const WORKSPACE_WEB_GATEWAY_AGENT_NAMESPACE = '/workspace-web-gateway-agent';
export const WORKSPACE_WEB_GATEWAY_AGENT_SOCKET_PATH = '/workspace-web-gateway-ws';
export const WORKSPACE_WEB_GATEWAY_HTTP_CHUNK_BYTES = 64 * 1024;
export const WORKSPACE_WEB_GATEWAY_SOCKET_CHUNK_BYTES = 64 * 1024;

/**
 * DataOps backend 与 workspace agent 共用这一份协议 schema；Zod 由两端宿主注入。
 * WebSocket 帧保持 opaque，Gateway 只中继 Upgrade 响应头和有界字节块。
 */
export const createWorkspaceWebGatewayProtocolSchemas = (z) => {
  const requestIdSchema = z.string().min(1).max(128);
  const pathSchema = z.string().min(1).max(16 * 1024).refine((value) => value.startsWith('/'), {
    message: 'gateway path must start with /',
  });
  const headerPairSchema = z.tuple([
    z.string().min(1).max(256),
    z.string().max(32 * 1024),
  ]);
  const headersSchema = z.array(headerPairSchema).max(128);
  const httpDataSchema = z.instanceof(Uint8Array).refine(
    (value) => value.byteLength <= WORKSPACE_WEB_GATEWAY_HTTP_CHUNK_BYTES,
    { message: 'HTTP tunnel chunk is too large' },
  );
  const socketDataSchema = z.instanceof(Uint8Array).refine(
    (value) => value.byteLength <= WORKSPACE_WEB_GATEWAY_SOCKET_CHUNK_BYTES,
    { message: 'socket tunnel chunk is too large' },
  );
  const upgradeHeadSchema = z.instanceof(Uint8Array).refine(
    (value) => value.byteLength <= 64 * 1024,
    { message: 'WebSocket upgrade head is too large' },
  );

  const httpStartSchema = z.object({
    type: z.literal('http_start'),
    requestId: requestIdSchema,
    method: z.string().min(1).max(32),
    path: pathSchema,
    headers: headersSchema,
  });
  const httpChunkSchema = z.object({
    type: z.literal('http_chunk'),
    requestId: requestIdSchema,
    sequence: z.number().int().positive(),
    data: httpDataSchema,
  });
  const httpEndSchema = z.object({
    type: z.literal('http_end'),
    requestId: requestIdSchema,
  });
  const httpAbortSchema = z.object({
    type: z.literal('http_abort'),
    requestId: requestIdSchema,
    reason: z.string().min(1).max(1024),
  });
  const wsOpenSchema = z.object({
    type: z.literal('ws_open'),
    requestId: requestIdSchema,
    path: pathSchema,
    headers: headersSchema,
    initialData: socketDataSchema.optional(),
  });
  const wsChunkToAgentSchema = z.object({
    type: z.literal('ws_chunk_to_agent'),
    requestId: requestIdSchema,
    sequence: z.number().int().positive(),
    data: socketDataSchema,
  });
  const wsCloseToAgentSchema = z.object({
    type: z.literal('ws_close_to_agent'),
    requestId: requestIdSchema,
    reason: z.string().min(1).max(1024),
  });

  const httpResponseStartSchema = z.object({
    type: z.literal('http_response_start'),
    requestId: requestIdSchema,
    status: z.number().int().min(100).max(599),
    headers: headersSchema,
  });
  const httpResponseChunkSchema = z.object({
    type: z.literal('http_response_chunk'),
    requestId: requestIdSchema,
    sequence: z.number().int().positive(),
    data: httpDataSchema,
  });
  const httpResponseEndSchema = z.object({
    type: z.literal('http_response_end'),
    requestId: requestIdSchema,
  });
  const httpErrorSchema = z.object({
    type: z.literal('http_error'),
    requestId: requestIdSchema,
    code: z.string().min(1).max(128),
    message: z.string().min(1).max(4096),
  });
  const wsOpenedSchema = z.object({
    type: z.literal('ws_opened'),
    requestId: requestIdSchema,
    responseHead: upgradeHeadSchema,
  });
  const wsChunkToServerSchema = z.object({
    type: z.literal('ws_chunk_to_server'),
    requestId: requestIdSchema,
    sequence: z.number().int().positive(),
    data: socketDataSchema,
  });
  const wsClosedSchema = z.object({
    type: z.literal('ws_closed'),
    requestId: requestIdSchema,
    reason: z.string().max(1024).optional(),
  });
  const wsErrorSchema = z.object({
    type: z.literal('ws_error'),
    requestId: requestIdSchema,
    code: z.string().min(1).max(128),
    message: z.string().min(1).max(4096),
  });

  return {
    requestIdSchema,
    pathSchema,
    headersSchema,
    httpDataSchema,
    socketDataSchema,
    upgradeHeadSchema,
    serverAgentMessageSchema: z.discriminatedUnion('type', [
      httpStartSchema,
      httpChunkSchema,
      httpEndSchema,
      httpAbortSchema,
      wsOpenSchema,
      wsChunkToAgentSchema,
      wsCloseToAgentSchema,
    ]),
    agentServerMessageSchema: z.discriminatedUnion('type', [
      httpResponseStartSchema,
      httpResponseChunkSchema,
      httpResponseEndSchema,
      httpErrorSchema,
      wsOpenedSchema,
      wsChunkToServerSchema,
      wsClosedSchema,
      wsErrorSchema,
    ]),
  };
};
