import type { Core } from "@strapi/strapi";
import { analyzeListingRequestSchema } from "../../../lib/ai/schemas";
import { checkAndRecordRateLimit, getRateLimitConfigFromEnv } from "../../../lib/ai/rate-limiter";

interface AiHttpContext {
  request: { body: unknown; ip?: string };
  state: { user?: { id: number } };
  badRequest: (message: string) => void;
  unauthorized: (message: string) => void;
  send: (body: unknown, status?: number) => void;
  status?: number;
  body?: unknown;
}

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async analyze(ctx: AiHttpContext) {
    const user = ctx.state.user;
    if (!user?.id) {
      ctx.unauthorized("You must be logged in to use the AI listing assistant.");
      return;
    }

    const parsedRequest = analyzeListingRequestSchema.safeParse(ctx.request.body);
    if (!parsedRequest.success) {
      ctx.badRequest(`Invalid request: ${parsedRequest.error.message}`);
      return;
    }

    const rateLimitConfig = getRateLimitConfigFromEnv((key, fallback) => process.env[key] ?? fallback);
    const rateLimit = await checkAndRecordRateLimit(strapi, user.id, rateLimitConfig);
    if (!rateLimit.allowed) {
      ctx.status = 429;
      ctx.body = { error: "Too many AI analysis requests. Please wait before trying again.", retryAfterMs: rateLimit.retryAfterMs };
      return;
    }

    const service = strapi.service("api::listing-ai.listing-ai") as unknown as {
      orchestrator: {
        analyze: (params: { userId: number; imageIds: number[]; categoryId: number | null; requestIp: string | null }) => Promise<{ ok: true; result: unknown } | { ok: false; httpStatus: number; message: string }>;
      };
    };

    const outcome = await service.orchestrator.analyze({
      userId: user.id,
      imageIds: parsedRequest.data.imageIds,
      categoryId: parsedRequest.data.categoryId ?? null,
      requestIp: ctx.request.ip ?? null,
    });

    if (!outcome.ok) {
      const failure = outcome as { ok: false; httpStatus: number; message: string };
      ctx.status = failure.httpStatus;
      ctx.body = { error: failure.message };
      return;
    }

    ctx.body = (outcome as { ok: true; result: unknown }).result;
  },

  async rescope(ctx: AiHttpContext) {
    const user = ctx.state.user;
    if (!user?.id) {
      ctx.unauthorized("You must be logged in to use the AI listing assistant.");
      return;
    }

    const body = ctx.request.body as { requestId?: unknown; categoryId?: unknown };
    const requestId = typeof body.requestId === "string" ? body.requestId : String(body.requestId ?? "");
    const categoryId = Number(body.categoryId);

    if (!requestId || !Number.isInteger(categoryId) || categoryId <= 0) {
      ctx.badRequest("requestId and a valid categoryId are required.");
      return;
    }

    const service = strapi.service("api::listing-ai.listing-ai") as unknown as {
      orchestrator: {
        rescope: (params: { requestId: string; categoryId: number }) => Promise<{ ok: true; result: unknown } | { ok: false; httpStatus: number; message: string }>;
      };
    };

    const outcome = await service.orchestrator.rescope({ requestId, categoryId });

    if (!outcome.ok) {
      const failure = outcome as { ok: false; httpStatus: number; message: string };
      ctx.status = failure.httpStatus;
      ctx.body = { error: failure.message };
      return;
    }

    ctx.body = (outcome as { ok: true; result: unknown }).result;
  },

  async feedback(ctx: AiHttpContext) {
    const user = ctx.state.user;
    if (!user?.id) {
      ctx.unauthorized("You must be logged in to submit feedback.");
      return;
    }

    const body = ctx.request.body as { requestId?: unknown; rating?: unknown; field?: unknown };
    const requestId = Number(typeof body.requestId === "string" ? body.requestId : body.requestId);
    const rating = String(body.rating ?? "");
    const feedbackField = String(body.field ?? "overall").trim().slice(0, 120);

    if (!Number.isInteger(requestId) || requestId <= 0) {
      ctx.badRequest("A valid numeric requestId is required.");
      return;
    }

    const VALID_RATINGS = ["correct", "incorrect", "incomplete"];
    if (!VALID_RATINGS.includes(rating)) {
      ctx.badRequest(`rating must be one of: ${VALID_RATINGS.join(", ")}.`);
      return;
    }

    try {
      const log = await (strapi as any).entityService.findOne(
        "api::ai-request-log.ai-request-log",
        requestId,
        { fields: ["id", "status"] },
      );

      if (!log || (log as any).status !== "success") {
        ctx.status = 404;
        ctx.body = { error: "No successful analysis found for this requestId." };
        return;
      }

      await (strapi as any).entityService.update(
        "api::ai-request-log.ai-request-log",
        requestId,
        { data: { feedbackRating: rating, feedbackField, feedbackAt: new Date().toISOString() } },
      );

      ctx.body = { ok: true };
    } catch {
      ctx.status = 500;
      ctx.body = { error: "Failed to save feedback." };
    }
  },
});
