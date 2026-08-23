# reddit-mcp

Read-only **Reddit Data API** MCP connector for **Cursor / Grok Bot** connect-card OAuth.
Runs as a **Cloudflare Worker** that speaks **MCP Streamable HTTP** and **passes through** the caller's `Authorization: Bearer` token to `https://oauth.reddit.com`.

Repository: https://github.com/pmsorhaindo/reddit-mcp

## Architecture

```
Cursor / Grok Bot
   │  OAuth (connect-card) against Reddit authorize/token
   │  then MCP JSON-RPC with Bearer access token
   ▼
Cloudflare Worker (this repo)
   │  POST /mcp  → tools/list, tools/call
   │  GET  /.well-known/oauth-*  → discovery pointing at Reddit
   ▼
https://oauth.reddit.com  (User-Agent from env, Bearer passthrough)
```

| Route | Purpose |
| --- | --- |
| `GET /` or `/health` | Liveness + endpoint map |
| `POST /mcp` | MCP Streamable HTTP (JSON-RPC: `initialize`, `tools/list`, `tools/call`) |
| `GET /.well-known/oauth-authorization-server` | OAuth AS metadata (Reddit authorize/token) |
| `GET /.well-known/oauth-protected-resource` | Protected-resource metadata for this MCP URL |
| `GET /callback` | Dev landing page only — **does not** exchange codes |

### Why minimal JSON-RPC (not the full MCP SDK)?

`@modelcontextprotocol/sdk` historically targeted Node transports. This Worker implements a **Workers-native**, dependency-light Streamable HTTP JSON-RPC surface (`initialize` / `tools/list` / `tools/call`) that matches what Cursor/Grok need for tool calling, without Durable Objects or session stores. That fits **bearer passthrough**: the Worker never holds Reddit refresh tokens.

### Tools

| Tool | Reddit API | Scopes |
| --- | --- | --- |
| `get_me` | `GET /api/v1/me` | `identity` |
| `list_subscriptions` | `GET /subreddits/mine/subscriber` | `mysubreddits` |
| `get_user_history` | `GET /user/{user}/{overview\|submitted\|comments}` | `history`, `read` |
| `get_subreddit_feed` | `GET /r/{sub}/{hot\|new\|top\|rising\|controversial}` | `read` |
| `search_reddit` | `GET /search` or `/r/{sub}/search` | `read` |

All tools return **compact JSON** (truncated text fields). `limit` defaults to **25**, capped at **100**.

### Rate limiting

- Outbound Reddit calls are **serialized** per Worker isolate (promise chain).
- Response `X-Ratelimit-Remaining` / `X-Ratelimit-Reset` are honored before the next call.
- HTTP **429** / **503** trigger bounded retries with `Retry-After` or exponential backoff.

### Secret hygiene

**Never commit real secrets.**

- Strong `.gitignore` covers `.env`, `.dev.vars`, `.wrangler/`, `node_modules/`, `dist/`, `credentials*.json`, `.mcp-auth/`.
- Only **example** env files are committed: `.dev.vars.example`, `.env.example`.
- `wrangler.toml` has **no** inline secrets.
- Errors and `console` logs never include `Authorization` headers, tokens, or secret env values.
- Tool error payloads are status/message only — no upstream response bodies that might echo credentials.

## Reddit app setup

1. Create a Reddit app at https://www.reddit.com/prefs/apps (type **web app** or **installed app** as appropriate for your client).
2. Add redirect URIs:
   - `http://localhost:8787/callback` — local wrangler / manual testing
   - `https://www.cursor.com/agents/mcp/oauth/callback` — Cursor connect-card
3. Request scopes (comma-separated in Reddit authorize URLs):
   - `identity,read,mysubreddits,history`
4. Note `client_id` / `client_secret` for the **OAuth client** (Cursor / your secrets manager). **Do not** put them in this repo or in `wrangler.toml`.

### OAuth discovery assumptions

- `/.well-known/oauth-authorization-server` advertises:
  - `authorization_endpoint`: `https://www.reddit.com/api/v1/authorize`
  - `token_endpoint`: `https://www.reddit.com/api/v1/access_token`
- This Worker **does not** perform authorization-code exchange and **does not** store refresh tokens.
- Cursor/Grok complete OAuth with Reddit (using the Reddit app credentials you configure in the client), then send `Authorization: Bearer <access_token>` on MCP requests.
- `issuer` in the metadata is this Worker's origin so MCP clients can discover docs from the MCP base URL; authorize/token still happen on Reddit.
- Reddit scopes are traditionally **comma-separated** on the authorize URL — clients must join scopes accordingly.

## Cloudflare deploy

Prerequisites: Node 22+, Cloudflare account, Wrangler logged in (`npx wrangler login`).

```bash
git clone https://github.com/pmsorhaindo/reddit-mcp.git
cd reddit-mcp
npm install

# Local secrets (gitignored)
cp .dev.vars.example .dev.vars
# edit USER_AGENT — must identify you per Reddit API rules

npm run typecheck
npm run dev          # http://127.0.0.1:8787

# Production secret (not committed)
npx wrangler secret put USER_AGENT
npm run deploy
```

`USER_AGENT` example shape (placeholder only):

```text
cloudflare-worker:reddit-mcp:0.1.0 (by /u/YOUR_REDDIT_USERNAME)
```

After deploy, note the workers.dev or custom domain URL, e.g. `https://reddit-mcp.<account>.workers.dev`.

## Add MCP server (Cursor / Grok)

Configure **AddMcpServer** (or equivalent connect-card) with:

| Field | Value |
| --- | --- |
| URL | `https://<your-worker>/mcp` |
| Auth | OAuth (connect-card) |
| Scopes | `identity` `read` `mysubreddits` `history` |

The client should use your Reddit app's client id/secret and the Cursor redirect URI above. After auth, MCP tool calls must include the Reddit access token as a Bearer header; this Worker forwards it upstream.

## Smoke tests

Replace `$BASE` and `$TOKEN` locally — **do not** commit tokens.

```bash
BASE=http://127.0.0.1:8787
TOKEN=reddit_access_token_here

# Health
curl -sS "$BASE/health"

# OAuth metadata
curl -sS "$BASE/.well-known/oauth-authorization-server"
curl -sS "$BASE/.well-known/oauth-protected-resource"

# MCP initialize
curl -sS -X POST "$BASE/mcp" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'

# tools/list
curl -sS -X POST "$BASE/mcp" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# tools/call get_me (requires valid Bearer)
curl -sS -X POST "$BASE/mcp" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_me","arguments":{}}}'
```

Expected: JSON-RPC results; `get_me` returns compact profile fields. Missing Bearer → JSON-RPC error `Unauthorized` without leaking headers.

## Scripts

| Script | Command |
| --- | --- |
| `npm run dev` | `wrangler dev` |
| `npm run deploy` | `wrangler deploy` |
| `npm run typecheck` | `tsc --noEmit` |

## Out of scope

- Writing, voting, messaging, moderation, or Ads API
- Storing Reddit refresh tokens or client secrets on the Worker
- Performing OAuth code exchange on `/callback`
- Full MCP resources/prompts/sampling/elicitation sessions
- Multi-tenant token vaults / Durable Object session stores
- Guaranteeing cross-isolate global rate-limit coordination (limits are per isolate + Reddit headers)

## License

Private / unpublished unless you add a license file.
