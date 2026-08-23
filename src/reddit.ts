import type { Env } from "./types.js";

const REDDIT_OAUTH_BASE = "https://oauth.reddit.com";
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const MAX_RETRIES = 3;

/** Serialize all outbound Reddit calls within this isolate. */
let outboundChain: Promise<unknown> = Promise.resolve();

/** Soft rate-limit state learned from X-Ratelimit-* headers. */
let rateLimitRemaining: number | null = null;
let rateLimitResetMs = 0;

export class RedditApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "RedditApiError";
  }
}

export function clampLimit(limit: unknown): number {
  if (limit === undefined || limit === null || limit === "") {
    return DEFAULT_LIMIT;
  }
  const n = typeof limit === "number" ? limit : Number(limit);
  if (!Number.isFinite(n) || n < 1) {
    return DEFAULT_LIMIT;
  }
  return Math.min(MAX_LIMIT, Math.floor(n));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseResetMs(header: string | null): number {
  if (!header) return 0;
  const asNumber = Number(header);
  if (!Number.isFinite(asNumber)) return 0;
  // Reddit usually sends unix seconds; accept ms if already large.
  if (asNumber > 1e12) return asNumber;
  if (asNumber > 1e9) return asNumber * 1000;
  // Relative seconds until reset
  return Date.now() + asNumber * 1000;
}

function updateRateLimitFromHeaders(headers: Headers): void {
  const remaining = headers.get("x-ratelimit-remaining");
  const reset = headers.get("x-ratelimit-reset");
  if (remaining !== null) {
    const n = Number(remaining);
    rateLimitRemaining = Number.isFinite(n) ? n : rateLimitRemaining;
  }
  if (reset !== null) {
    rateLimitResetMs = parseResetMs(reset) || rateLimitResetMs;
  }
}

async function waitForRateBudget(): Promise<void> {
  if (rateLimitRemaining !== null && rateLimitRemaining <= 0 && rateLimitResetMs > Date.now()) {
    const waitMs = Math.min(60_000, Math.max(250, rateLimitResetMs - Date.now() + 50));
    await sleep(waitMs);
  }
}

function retryAfterMs(headers: Headers, attempt: number): number {
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(60_000, Math.max(250, seconds * 1000));
    }
  }
  if (rateLimitResetMs > Date.now()) {
    return Math.min(60_000, Math.max(250, rateLimitResetMs - Date.now() + 50));
  }
  // Exponential backoff with jitter
  const base = Math.min(30_000, 500 * 2 ** attempt);
  return base + Math.floor(Math.random() * 250);
}

/**
 * Authenticated GET against oauth.reddit.com.
 * Passes through the caller's Bearer token. Never logs Authorization.
 */
export async function redditGet<
  T = unknown,
>(
  env: Env,
  accessToken: string,
  path: string,
  query: Record<string, string | number | undefined | null> = {},
): Promise<T> {
  if (!env.USER_AGENT || !env.USER_AGENT.trim()) {
    throw new RedditApiError("USER_AGENT env is not configured", 500, false);
  }

  const url = new URL(path.startsWith("http") ? path : `${REDDIT_OAUTH_BASE}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  // Prefer compact JSON from Reddit
  if (!url.searchParams.has("raw_json")) {
    url.searchParams.set("raw_json", "1");
  }

  const run = async (): Promise<T> => {
    let lastError: RedditApiError | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      await waitForRateBudget();

      const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": env.USER_AGENT,
          Accept: "application/json",
        },
      });

      updateRateLimitFromHeaders(response.headers);

      if (response.status === 429 || response.status === 503) {
        const waitMs = retryAfterMs(response.headers, attempt);
        // Consume body to free the connection; discard content (may contain noise).
        await response.arrayBuffer().catch(() => undefined);
        if (attempt === MAX_RETRIES) {
          throw new RedditApiError(`Reddit rate limited (${response.status})`, response.status, true);
        }
        await sleep(waitMs);
        continue;
      }

      if (!response.ok) {
        await response.arrayBuffer().catch(() => undefined);
        const retryable = response.status >= 500;
        throw new RedditApiError(`Reddit API error (${response.status})`, response.status, retryable);
      }

      return (await response.json()) as T;
    }

    throw lastError ?? new RedditApiError("Reddit request failed", 500, true);
  };

  // Chain outbound calls so they never overlap in this isolate.
  const result = outboundChain.then(run, run);
  outboundChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function extractBearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header) return null;
  const match = /^Bearer\s+(\S+)/i.exec(header.trim());
  return match?.[1] ?? null;
}
