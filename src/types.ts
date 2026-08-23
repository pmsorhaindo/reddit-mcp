/** Cloudflare Worker bindings. Never log or return secret values. */
export interface Env {
  /** Reddit-required User-Agent string (set via wrangler secret / .dev.vars). */
  USER_AGENT: string;
}

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpTextContent {
  type: "text";
  text: string;
}

export interface McpToolResult {
  content: McpTextContent[];
  isError?: boolean;
}

export interface RedditListingChild<T = Record<string, unknown>> {
  kind: string;
  data: T;
}

export interface RedditListing<T = Record<string, unknown>> {
  kind: string;
  data: {
    after: string | null;
    before: string | null;
    dist?: number;
    children: RedditListingChild<T>[];
  };
}
