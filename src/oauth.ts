/**
 * OAuth discovery documents for Cursor/Grok connect-card flows.
 *
 * Assumptions (documented in README):
 * - This Worker does NOT store Reddit client secrets or perform code exchange.
 * - Clients (Cursor connect-card) complete OAuth against Reddit directly,
 *   then call this MCP server with Authorization: Bearer <access_token>.
 * - Well-known metadata points at Reddit's authorize/token endpoints so
 *   clients can discover where to send the user.
 */

const REDDIT_AUTHORIZE = "https://www.reddit.com/api/v1/authorize";
const REDDIT_TOKEN = "https://www.reddit.com/api/v1/access_token";
const REDDIT_REVOCATION = "https://www.reddit.com/api/v1/revoke_token";

export const RECOMMENDED_SCOPES = [
  "identity",
  "read",
  "mysubreddits",
  "history",
] as const;

export function oauthAuthorizationServerMetadata(requestUrl: URL): Response {
  const issuer = `${requestUrl.protocol}//${requestUrl.host}`;
  const body = {
    issuer,
    authorization_endpoint: REDDIT_AUTHORIZE,
    token_endpoint: REDDIT_TOKEN,
    revocation_endpoint: REDDIT_REVOCATION,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    code_challenge_methods_supported: ["plain", "S256"],
    scopes_supported: [...RECOMMENDED_SCOPES],
    service_documentation: "https://github.com/reddit-archive/reddit/wiki/OAuth2",
    // Reddit uses comma-separated scopes in authorize URLs; clients should join accordingly.
    //
    // NOTE: authorization/token happen on reddit.com, not on this Worker.
    // The issuer is this Worker so MCP clients discover metadata from the MCP base URL.
  };
  return new Response(JSON.stringify(body, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export function oauthProtectedResourceMetadata(requestUrl: URL): Response {
  const resource = `${requestUrl.protocol}//${requestUrl.host}`;
  const body = {
    resource,
    authorization_servers: [resource],
    scopes_supported: [...RECOMMENDED_SCOPES],
    bearer_methods_supported: ["header"],
    resource_documentation: "https://github.com/pmsorhaindo/reddit-mcp",
  };
  return new Response(JSON.stringify(body, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/** Local/dev redirect landing page — does not exchange codes or store secrets. */
export function callbackLanding(): Response {
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"/><title>reddit-mcp OAuth callback</title></head>
<body>
  <h1>OAuth callback received</h1>
  <p>This Worker uses <strong>bearer passthrough</strong>. It does not exchange authorization codes.</p>
  <p>For Cursor, prefer the connect-card redirect:
    <code>https://www.cursor.com/agents/mcp/oauth/callback</code>
  </p>
  <p>For local wrangler testing you may register
    <code>http://localhost:8787/callback</code>
    on your Reddit app; complete token exchange in your OAuth client, then call
    <code>POST /mcp</code> with <code>Authorization: Bearer &lt;access_token&gt;</code>.
  </p>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}
