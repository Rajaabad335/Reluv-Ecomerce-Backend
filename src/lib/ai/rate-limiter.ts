import type { Core } from "@strapi/strapi";

export interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export async function checkAndRecordRateLimit(
  strapi: Core.Strapi,
  userId: number,
  config: RateLimitConfig,
): Promise<RateLimitResult> {
  const windowStart = new Date(Date.now() - config.windowMs).toISOString();

  const recentCount = await strapi.db.query("api::ai-request-log.ai-request-log").count({
    where: {
      users_permissions_user: userId,
      createdAt: { $gte: windowStart },
    },
  });

  if (recentCount >= config.maxRequests) {
    return { allowed: false, remaining: 0, retryAfterMs: config.windowMs };
  }

  return { allowed: true, remaining: Math.max(0, config.maxRequests - recentCount - 1), retryAfterMs: 0 };
}

export function getRateLimitConfigFromEnv(
  env: (key: string, fallback?: string) => string | undefined,
): RateLimitConfig {
  const maxRequests = Number(env("AI_ANALYZE_RATE_LIMIT_MAX", "20"));
  const windowMs = Number(env("AI_ANALYZE_RATE_LIMIT_WINDOW_MS", "3600000"));

  return {
    maxRequests: Number.isFinite(maxRequests) && maxRequests > 0 ? maxRequests : 20,
    windowMs: Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 3600000,
  };
}
