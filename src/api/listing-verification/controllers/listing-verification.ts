import type { Context } from "koa";
import type { Core } from "@strapi/strapi";
import { factories } from "@strapi/strapi";
import { submitLuxuryEvidenceRequestSchema, verificationDecisionRequestSchema } from "../../../lib/ai/schemas";
import { NotVerificationOwnerError, VerificationNotFoundError } from "../services/listing-verification";

interface StrapiCtxHelpers {
  state: { user?: { id: number } };
  params: Record<string, string | undefined>;
  request: { body: unknown };
  badRequest: (message: string) => void;
  unauthorized: (message: string) => void;
  forbidden: (message: string) => void;
  notFound: (message: string) => void;
  body?: unknown;
}

function helpers(ctx: Context): StrapiCtxHelpers {
  return ctx as unknown as StrapiCtxHelpers;
}

export default factories.createCoreController(
  "api::listing-verification.listing-verification",
  ({ strapi }: { strapi: Core.Strapi }) => ({
    async submitEvidence(ctx: Context) {
      const h = helpers(ctx);
      const user = h.state.user;
      if (!user?.id) { h.unauthorized("You must be logged in to submit verification evidence."); return; }

      const parsed = submitLuxuryEvidenceRequestSchema.safeParse(h.request.body);
      if (!parsed.success) { h.badRequest(`Invalid request: ${parsed.error.message}`); return; }

      const service = strapi.service("api::listing-verification.listing-verification") as unknown as {
        submitEvidence: (userId: number, payload: typeof parsed.data) => Promise<unknown>;
      };

      try {
        h.body = await service.submitEvidence(user.id, parsed.data);
      } catch (error) {
        if (error instanceof VerificationNotFoundError) { h.notFound(error.message); return; }
        if (error instanceof NotVerificationOwnerError) { h.forbidden(error.message); return; }
        throw error;
      }
    },

    async decision(ctx: Context) {
      const h = helpers(ctx);
      const adminUser = h.state.user;
      if (!adminUser?.id) { h.unauthorized("Admin authentication required."); return; }

      const verificationId = Number(h.params.id);
      if (!Number.isInteger(verificationId) || verificationId <= 0) { h.badRequest("A valid verification id is required in the URL."); return; }

      const parsed = verificationDecisionRequestSchema.safeParse(h.request.body);
      if (!parsed.success) { h.badRequest(`Invalid request: ${parsed.error.message}`); return; }

      const service = strapi.service("api::listing-verification.listing-verification") as unknown as {
        applyDecision: (verificationId: number, adminUserId: number, decision: typeof parsed.data) => Promise<unknown>;
      };

      try {
        h.body = await service.applyDecision(verificationId, adminUser.id, parsed.data);
      } catch (error) {
        if (error instanceof VerificationNotFoundError) { h.notFound(error.message); return; }
        throw error;
      }
    },

    async mine(ctx: Context) {
      const h = helpers(ctx);
      const user = h.state.user;
      if (!user?.id) { h.unauthorized("You must be logged in."); return; }

      const productId = Number(h.params.productId);
      if (!Number.isInteger(productId) || productId <= 0) { h.badRequest("A valid productId is required."); return; }

      const product = (await strapi.entityService.findOne("api::product.product", productId, {
        populate: { users_permissions_user: { fields: ["id"] }, listing_verification: true },
      })) as unknown as { users_permissions_user?: { id: number } | null; listing_verification?: unknown } | null;

      if (!product) { h.notFound("Product not found."); return; }
      if (product.users_permissions_user?.id !== user.id) { h.forbidden("You do not own this listing."); return; }

      h.body = product.listing_verification ?? null;
    },
  }),
);
