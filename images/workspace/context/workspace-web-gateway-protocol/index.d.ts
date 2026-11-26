export declare const WORKSPACE_WEB_GATEWAY_PROTOCOL_VERSION: 1;
export declare const WORKSPACE_WEB_GATEWAY_AGENT_NAMESPACE: '/workspace-web-gateway-agent';
export declare const WORKSPACE_WEB_GATEWAY_AGENT_SOCKET_PATH: '/workspace-web-gateway-ws';
export declare const WORKSPACE_WEB_GATEWAY_HTTP_CHUNK_BYTES: number;
export declare const WORKSPACE_WEB_GATEWAY_SOCKET_CHUNK_BYTES: number;

export type WorkspaceWebGatewayHeader = readonly [string, string];

export type WorkspaceWebGatewayServerAgentMessage =
  | { type: 'http_start'; requestId: string; method: string; path: string; headers: WorkspaceWebGatewayHeader[] }
  | { type: 'http_chunk'; requestId: string; sequence: number; data: Uint8Array }
  | { type: 'http_end'; requestId: string }
  | { type: 'http_abort'; requestId: string; reason: string }
  | { type: 'ws_open'; requestId: string; path: string; headers: WorkspaceWebGatewayHeader[]; initialData?: Uint8Array }
  | { type: 'ws_chunk_to_agent'; requestId: string; sequence: number; data: Uint8Array }
  | { type: 'ws_close_to_agent'; requestId: string; reason: string };

export type WorkspaceWebGatewayAgentServerMessage =
  | { type: 'http_response_start'; requestId: string; status: number; headers: WorkspaceWebGatewayHeader[] }
  | { type: 'http_response_chunk'; requestId: string; sequence: number; data: Uint8Array }
  | { type: 'http_response_end'; requestId: string }
  | { type: 'http_error'; requestId: string; code: string; message: string }
  | { type: 'ws_opened'; requestId: string; responseHead: Uint8Array }
  | { type: 'ws_chunk_to_server'; requestId: string; sequence: number; data: Uint8Array }
  | { type: 'ws_closed'; requestId: string; reason?: string }
  | { type: 'ws_error'; requestId: string; code: string; message: string };

export declare const createWorkspaceWebGatewayProtocolSchemas: (z: any) => {
  requestIdSchema: any;
  pathSchema: any;
  headersSchema: any;
  httpDataSchema: any;
  socketDataSchema: any;
  upgradeHeadSchema: any;
  serverAgentMessageSchema: { parse(value: unknown): WorkspaceWebGatewayServerAgentMessage };
  agentServerMessageSchema: { parse(value: unknown): WorkspaceWebGatewayAgentServerMessage };
};
