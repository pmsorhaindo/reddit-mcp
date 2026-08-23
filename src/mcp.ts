import { extractBearerToken } from "./reddit.js";
import { TOOL_DEFINITIONS, callTool } from "./tools.js";
import type { Env, JsonRpcId, JsonRpcRequest, JsonRpcResponse } from "./types.js";

const SERVER_INFO = {
  name: "reddit-mcp",
  version: "0.1.0",
} as const;

const PROTOCOL_VERSION = "2025-03-26";

function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

function rpcResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return obj.jsonrpc === "2.0" && typeof obj.method === "string";
}

function asArgs(params: unknown): Record<string, unknown> {
  if (!params || typeof params !== "object") return {};
  const obj = params as Record<string, unknown>;
  const args = obj.arguments;
  if (args && typeof args === "object" && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  return {};
}

async function handleSingle(
  env: Env,
  request: Request,
  msg: JsonRpcRequest,
): Promise<JsonRpcResponse | null> {
  const id: JsonRpcId = msg.id === undefined ? null : msg.id;
  const isNotification = msg.id === undefined;

  switch (msg.method) {
    case "initialize": {
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: { listChanged: false },
        },
        serverInfo: SERVER_INFO,
        instructions:
          "Read-only Reddit Data API via bearer passthrough. Send Authorization: Bearer <reddit_access_token>. Scopes: identity, read, mysubreddits, history.",
      });
    }
    case "notifications/initialized":
    case "initialized":
      return isNotification ? null : rpcResult(id, {});
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: TOOL_DEFINITIONS });
    case "tools/call": {
      const params = (msg.params ?? {}) as Record<string, unknown>;
      const name = typeof params.name === "string" ? params.name : "";
      if (!name) {
        return rpcError(id, -32602, "Missing tool name");
      }
      const token = extractBearerToken(request);
      if (!token) {
        return rpcError(id, -32001, "Unauthorized: missing Bearer access token");
      }
      const result = await callTool(env, token, name, asArgs(msg.params));
      return rpcResult(id, result);
    }
    case "resources/list":
      return rpcResult(id, { resources: [] });
    case "prompts/list":
      return rpcResult(id, { prompts: [] });
    default:
      if (isNotification) return null;
      return rpcError(id, -32601, `Method not found: ${msg.method}`);
  }
}

/**
 * Minimal MCP Streamable HTTP handler (JSON-RPC over POST).
 * Intentionally avoids @modelcontextprotocol/sdk so the Worker stays
 * dependency-light and Workers-native. Supports initialize, tools/list,
 * tools/call — enough for Cursor/Grok connect-card clients.
 */
export async function handleMcpRequest(request: Request, env: Env): Promise<Response> {
  const cors: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
    "Access-Control-Expose-Headers": "MCP-Protocol-Version",
    "MCP-Protocol-Version": PROTOCOL_VERSION,
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  if (request.method === "GET") {
    // Stateless server: no long-lived SSE listen stream.
    return jsonResponse(
      {
        error: "This MCP server is stateless Streamable HTTP. Use POST with JSON-RPC.",
        server: SERVER_INFO,
      },
      405,
      { ...cors, Allow: "POST, OPTIONS" },
    );
  }

  if (request.method === "DELETE") {
    // No server-side sessions to tear down.
    return new Response(null, { status: 204, headers: cors });
  }

  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405, cors);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(rpcError(null, -32700, "Parse error"), 400, cors);
  }

  // Batch or single
  if (Array.isArray(body)) {
    if (body.length === 0) {
      return jsonResponse(rpcError(null, -32600, "Invalid Request: empty batch"), 400, cors);
    }
    const responses: JsonRpcResponse[] = [];
    for (const item of body) {
      if (!isJsonRpcRequest(item)) {
        responses.push(rpcError(null, -32600, "Invalid Request"));
        continue;
      }
      const res = await handleSingle(env, request, item);
      if (res) responses.push(res);
    }
    if (responses.length === 0) {
      return new Response(null, { status: 202, headers: cors });
    }
    return jsonResponse(responses, 200, cors);
  }

  if (!isJsonRpcRequest(body)) {
    return jsonResponse(rpcError(null, -32600, "Invalid Request"), 400, cors);
  }

  const res = await handleSingle(env, request, body);
  if (!res) {
    return new Response(null, { status: 202, headers: cors });
  }
  return jsonResponse(res, 200, cors);
}
