import { rateLimited } from "@/lib/api-errors";

/**
 * Lightweight sliding-window rate limiter for Vercel serverless.
 *
 * State is a per-instance Map (no external Redis), so limits are enforced per
 * warm function instance. That still stops naive brute-force/burst abuse and
 * has zero infra cost; swap `store` for Upstash if cross-instance accuracy is needed.
 */

interface WindowEntry {
  /** request timestamps (ms) inside the current window, oldest first */
  hits: number[];
}

const MAX_KEYS = 5000; // hard cap so memory can't grow unbounded
const store = new Map<string, WindowEntry>();

export interface RateLimitConfig {
  /** max requests allowed within `windowMs` */
  limit: number;
  windowMs: number;
}

export interface RateLimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  /** seconds until the oldest hit leaves the window */
  retryAfterSec: number;
}

/** Predefined policies */
export const RATE_LIMITS = {
  signup: { limit: 5, windowMs: 60_000 } as RateLimitConfig,
  login: { limit: 10, windowMs: 60_000 } as RateLimitConfig,
  ai: { limit: 20, windowMs: 60_000 } as RateLimitConfig,
  payment: { limit: 60, windowMs: 60_000 } as RateLimitConfig,
  api: { limit: 120, windowMs: 60_000 } as RateLimitConfig,
};

function evict() {
  if (store.size <= MAX_KEYS) return;
  // Drop the oldest ~10% of keys (Map preserves insertion order)
  let n = Math.ceil(MAX_KEYS * 0.1);
  for (const key of store.keys()) {
    store.delete(key);
    if (--n <= 0) break;
  }
}

/** Sliding-window check. Records the hit when allowed. */
export function checkRateLimit(key: string, config: RateLimitConfig): RateLimitResult {
  const now = Date.now();
  const windowStart = now - config.windowMs;

  let entry = store.get(key);
  if (!entry) {
    entry = { hits: [] };
    store.set(key, entry);
    evict();
  }

  // Drop hits outside the window
  while (entry.hits.length && entry.hits[0] <= windowStart) entry.hits.shift();

  if (entry.hits.length >= config.limit) {
    const retryAfterMs = entry.hits[0] + config.windowMs - now;
    return {
      success: false,
      limit: config.limit,
      remaining: 0,
      retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)),
    };
  }

  entry.hits.push(now);
  return {
    success: true,
    limit: config.limit,
    remaining: config.limit - entry.hits.length,
    retryAfterSec: 0,
  };
}

/** Best-effort client IP extraction behind Vercel's proxy. */
export function getClientIp(request: Request): string {
  const h = request.headers;
  const fwd = h.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return h.get("x-real-ip") || h.get("cf-connecting-ip") || "unknown";
}

/**
 * Convenience: check a limit and return a ready 429 Response when exceeded, or null when allowed.
 *
 *   const limited = rateLimitOr429(`signup:${getClientIp(req)}`, RATE_LIMITS.signup);
 *   if (limited) return limited;
 */
export function rateLimitOr429(key: string, config: RateLimitConfig) {
  const result = checkRateLimit(key, config);
  if (result.success) return null;
  return rateLimited(result.retryAfterSec);
}

/** Per-IP helper */
export function rateLimitByIp(request: Request, scope: string, config: RateLimitConfig) {
  return rateLimitOr429(`${scope}:ip:${getClientIp(request)}`, config);
}

/** Per-user helper (falls back to IP when no user id is available) */
export function rateLimitByUser(request: Request, scope: string, userKey: string | null | undefined, config: RateLimitConfig) {
  const id = userKey || `ip:${getClientIp(request)}`;
  return rateLimitOr429(`${scope}:user:${id}`, config);
}
