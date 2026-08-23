import { clampLimit, redditGet, RedditApiError } from "./reddit.js";
import type { Env, McpToolDefinition, McpToolResult, RedditListing } from "./types.js";

function textResult(payload: unknown, isError = false): McpToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function compactPost(data: Record<string, unknown>) {
  return {
    id: data.id,
    name: data.name,
    title: data.title,
    author: data.author,
    subreddit: data.subreddit,
    score: data.score,
    ups: data.ups,
    downs: data.downs,
    num_comments: data.num_comments,
    created_utc: data.created_utc,
    url: data.url,
    permalink: data.permalink,
    is_self: data.is_self,
    selftext: typeof data.selftext === "string" ? data.selftext.slice(0, 500) : data.selftext,
    link_flair_text: data.link_flair_text,
    over_18: data.over_18,
    stickied: data.stickied,
  };
}

function compactComment(data: Record<string, unknown>) {
  return {
    id: data.id,
    name: data.name,
    author: data.author,
    subreddit: data.subreddit,
    score: data.score,
    created_utc: data.created_utc,
    body: typeof data.body === "string" ? data.body.slice(0, 500) : data.body,
    permalink: data.permalink,
    link_id: data.link_id,
    parent_id: data.parent_id,
  };
}

function compactSubreddit(data: Record<string, unknown>) {
  return {
    id: data.id,
    name: data.name,
    display_name: data.display_name,
    title: data.title,
    subscribers: data.subscribers,
    url: data.url,
    over18: data.over18,
    public_description:
      typeof data.public_description === "string"
        ? data.public_description.slice(0, 300)
        : data.public_description,
  };
}

function compactListingItem(child: { kind: string; data: Record<string, unknown> }) {
  if (child.kind === "t3") return { kind: "post", ...compactPost(child.data) };
  if (child.kind === "t1") return { kind: "comment", ...compactComment(child.data) };
  if (child.kind === "t5") return { kind: "subreddit", ...compactSubreddit(child.data) };
  return { kind: child.kind, id: child.data.id, name: child.data.name };
}

export const TOOL_DEFINITIONS: McpToolDefinition[] = [
  {
    name: "get_me",
    description: "Return the authenticated Reddit user profile (requires identity scope).",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "list_subscriptions",
    description: "List subreddits the authenticated user is subscribed to (mysubreddits scope).",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          default: 25,
          description: "Max items to return (default 25, max 100).",
        },
        after: { type: "string", description: "Reddit listing fullname cursor for pagination." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_user_history",
    description:
      "Fetch a user's overview, submitted posts, or comments (history/read). Defaults to the authenticated user when username omitted.",
    inputSchema: {
      type: "object",
      properties: {
        username: {
          type: "string",
          description: "Reddit username without /u/. Omit to use the authenticated user.",
        },
        where: {
          type: "string",
          enum: ["overview", "submitted", "comments"],
          default: "overview",
        },
        sort: {
          type: "string",
          enum: ["new", "hot", "top", "controversial"],
          default: "new",
        },
        t: {
          type: "string",
          enum: ["hour", "day", "week", "month", "year", "all"],
          description: "Time window when sort is top or controversial.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          default: 25,
        },
        after: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_subreddit_feed",
    description: "Fetch a subreddit listing (hot/new/top/rising/controversial). Requires read scope.",
    inputSchema: {
      type: "object",
      properties: {
        subreddit: {
          type: "string",
          description: "Subreddit name without r/.",
        },
        sort: {
          type: "string",
          enum: ["hot", "new", "top", "rising", "controversial"],
          default: "hot",
        },
        t: {
          type: "string",
          enum: ["hour", "day", "week", "month", "year", "all"],
          description: "Time window when sort is top or controversial.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          default: 25,
        },
        after: { type: "string" },
      },
      required: ["subreddit"],
      additionalProperties: false,
    },
  },
  {
    name: "search_reddit",
    description: "Search Reddit posts (and optionally restrict to a subreddit). Requires read scope.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query." },
        subreddit: {
          type: "string",
          description: "Optional subreddit to restrict search (without r/).",
        },
        sort: {
          type: "string",
          enum: ["relevance", "hot", "top", "new", "comments"],
          default: "relevance",
        },
        t: {
          type: "string",
          enum: ["hour", "day", "week", "month", "year", "all"],
          default: "all",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          default: 25,
        },
        after: { type: "string" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
];

export async function callTool(
  env: Env,
  accessToken: string,
  name: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  try {
    switch (name) {
      case "get_me":
        return await toolGetMe(env, accessToken);
      case "list_subscriptions":
        return await toolListSubscriptions(env, accessToken, args);
      case "get_user_history":
        return await toolGetUserHistory(env, accessToken, args);
      case "get_subreddit_feed":
        return await toolGetSubredditFeed(env, accessToken, args);
      case "search_reddit":
        return await toolSearchReddit(env, accessToken, args);
      default:
        return textResult({ error: `Unknown tool: ${name}` }, true);
    }
  } catch (err) {
    if (err instanceof RedditApiError) {
      return textResult(
        {
          error: err.message,
          status: err.status,
          retryable: err.retryable,
        },
        true,
      );
    }
    const message = err instanceof Error ? err.message : "Tool failed";
    // Never include tokens/headers in error payloads.
    return textResult({ error: message }, true);
  }
}

async function toolGetMe(env: Env, accessToken: string): Promise<McpToolResult> {
  const me = asRecord(await redditGet(env, accessToken, "/api/v1/me"));
  return textResult({
    id: me.id,
    name: me.name,
    created_utc: me.created_utc,
    link_karma: me.link_karma,
    comment_karma: me.comment_karma,
    total_karma: me.total_karma,
    verified: me.verified,
    has_verified_email: me.has_verified_email,
    is_gold: me.is_gold,
    is_mod: me.is_mod,
    icon_img: me.icon_img,
  });
}

async function toolListSubscriptions(
  env: Env,
  accessToken: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const limit = clampLimit(args.limit);
  const listing = await redditGet<RedditListing>(env, accessToken, "/subreddits/mine/subscriber", {
    limit,
    after: typeof args.after === "string" ? args.after : undefined,
  });
  const children = listing.data?.children ?? [];
  return textResult({
    count: children.length,
    after: listing.data?.after ?? null,
    before: listing.data?.before ?? null,
    subreddits: children.map((c) => compactSubreddit(asRecord(c.data))),
  });
}

async function resolveUsername(
  env: Env,
  accessToken: string,
  username: unknown,
): Promise<string> {
  if (typeof username === "string" && username.trim()) {
    return username.replace(/^\/?u\//i, "").trim();
  }
  const me = asRecord(await redditGet(env, accessToken, "/api/v1/me"));
  if (typeof me.name !== "string" || !me.name) {
    throw new RedditApiError("Could not resolve authenticated username", 500, false);
  }
  return me.name;
}

async function toolGetUserHistory(
  env: Env,
  accessToken: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const username = await resolveUsername(env, accessToken, args.username);
  const where =
    args.where === "submitted" || args.where === "comments" || args.where === "overview"
      ? args.where
      : "overview";
  const sort =
    args.sort === "hot" ||
    args.sort === "top" ||
    args.sort === "controversial" ||
    args.sort === "new"
      ? args.sort
      : "new";
  const limit = clampLimit(args.limit);
  const listing = await redditGet<RedditListing>(
    env,
    accessToken,
    `/user/${encodeURIComponent(username)}/${where}`,
    {
      limit,
      sort,
      t: typeof args.t === "string" ? args.t : undefined,
      after: typeof args.after === "string" ? args.after : undefined,
    },
  );
  const children = listing.data?.children ?? [];
  return textResult({
    username,
    where,
    sort,
    count: children.length,
    after: listing.data?.after ?? null,
    items: children.map((c) => compactListingItem({ kind: c.kind, data: asRecord(c.data) })),
  });
}

async function toolGetSubredditFeed(
  env: Env,
  accessToken: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  if (typeof args.subreddit !== "string" || !args.subreddit.trim()) {
    return textResult({ error: "subreddit is required" }, true);
  }
  const subreddit = args.subreddit.replace(/^\/?r\//i, "").trim();
  const sort =
    args.sort === "new" ||
    args.sort === "top" ||
    args.sort === "rising" ||
    args.sort === "controversial" ||
    args.sort === "hot"
      ? args.sort
      : "hot";
  const limit = clampLimit(args.limit);
  const listing = await redditGet<RedditListing>(
    env,
    accessToken,
    `/r/${encodeURIComponent(subreddit)}/${sort}`,
    {
      limit,
      t: typeof args.t === "string" ? args.t : undefined,
      after: typeof args.after === "string" ? args.after : undefined,
    },
  );
  const children = listing.data?.children ?? [];
  return textResult({
    subreddit,
    sort,
    count: children.length,
    after: listing.data?.after ?? null,
    posts: children.map((c) => compactPost(asRecord(c.data))),
  });
}

async function toolSearchReddit(
  env: Env,
  accessToken: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  if (typeof args.query !== "string" || !args.query.trim()) {
    return textResult({ error: "query is required" }, true);
  }
  const limit = clampLimit(args.limit);
  const sort =
    args.sort === "hot" ||
    args.sort === "top" ||
    args.sort === "new" ||
    args.sort === "comments" ||
    args.sort === "relevance"
      ? args.sort
      : "relevance";
  const subreddit =
    typeof args.subreddit === "string" && args.subreddit.trim()
      ? args.subreddit.replace(/^\/?r\//i, "").trim()
      : undefined;
  const path = subreddit
    ? `/r/${encodeURIComponent(subreddit)}/search`
    : "/search";
  const listing = await redditGet<RedditListing>(env, accessToken, path, {
    q: args.query.trim(),
    limit,
    sort,
    t: typeof args.t === "string" ? args.t : "all",
    restrict_sr: subreddit ? "true" : undefined,
    type: "link",
    after: typeof args.after === "string" ? args.after : undefined,
  });
  const children = listing.data?.children ?? [];
  return textResult({
    query: args.query.trim(),
    subreddit: subreddit ?? null,
    sort,
    count: children.length,
    after: listing.data?.after ?? null,
    posts: children.map((c) => compactPost(asRecord(c.data))),
  });
}
