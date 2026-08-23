import { handleMcpRequest } from "./mcp.js";
import {
  callbackLanding,
  oauthAuthorizationServerMetadata,
  oauthProtectedResourceMetadata,
} from "./oauth.js";
import type { Env } from "./types.js";

function health(): Response {
  return new Response(
    JSON.stringify({
      name: "reddit-mcp",
      version: "0.1.0",
      mcp: "/mcp",
      oauth_authorization_server: "/.well-known/oauth-authorization-server",
      oauth_protected_resource: "/.well-known/oauth-protected-resource",
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    },
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      switch (path) {
        case "/":
        case "/health":
          return health();
        case "/mcp":
          return handleMcpRequest(request, env);
        case "/.well-known/oauth-authorization-server":
          return oauthAuthorizationServerMetadata(url);
        case "/.well-known/oauth-protected-resource":
          return oauthProtectedResourceMetadata(url);
        case "/callback":
          return callbackLanding();
        default:
          return new Response("Not found", { status: 404 });
      }
    } catch (err) {
      // Never include Authorization headers, tokens, or env secrets in errors/logs.
      const message = err instanceof Error ? err.message : "Internal error";
      console.error("request_failed", { path, message });
      return new Response(JSON.stringify({ error: "Internal Server Error" }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }
  },
} satisfies ExportedHandler<Env>;
