import type { Core } from "@strapi/strapi";
import type { SubmitLuxuryEvidenceRequest, VerificationDecisionRequest } from "../../../lib/ai/schemas";

const EVIDENCE_FIELD_MAP: Record<string, string> = {
  receiptImageIds: "receiptImages",
  invoiceImageIds: "invoiceImages",
  authenticityCardImageIds: "authenticityCardImages",
  warrantyCardImageIds: "warrantyCardImages",
  serialNumberImageIds: "serialNumberImages",
  qrCodeImageIds: "qrCodeImages",
  nfcTagImageIds: "nfcTagImages",
  logoCloseUpImageIds: "logoCloseUpImages",
  hardwarePhotoImageIds: "hardwarePhotoImages",
  stitchingPhotoImageIds: "stitchingPhotoImages",
  careLabelImageIds: "careLabelImages",
  materialLabelImageIds: "materialLabelImages",
};

export class VerificationNotFoundError extends Error {}
export class NotVerificationOwnerError extends Error {}

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async submitEvidence(userId: number, payload: SubmitLuxuryEvidenceRequest) {
    const product = (await strapi.entityService.findOne("api::product.product" as any, payload.productId, {
      populate: { users_permissions_user: { fields: ["id"] }, listing_verification: { fields: ["id"] } },
    })) as unknown as { users_permissions_user?: { id: number } | null; listing_verification?: { id: number } | null } | null;

    if (!product) throw new VerificationNotFoundError("Product not found.");
    if (product.users_permissions_user?.id !== userId) throw new NotVerificationOwnerError("You do not own this listing.");
    if (!product.listing_verification?.id) throw new VerificationNotFoundError("This listing does not require verification.");

    const verificationId = product.listing_verification.id;
    const existing = (await strapi.entityService.findOne(
      "api::listing-verification.listing-verification" as any,
      verificationId,
      { populate: Object.values(EVIDENCE_FIELD_MAP).reduce((acc, field) => ({ ...acc, [field]: { fields: ["id"] } }), {}) },
    )) as unknown as Record<string, Array<{ id: number }> | undefined>;

    const updateData: Record<string, number[]> = {};
    for (const [requestField, schemaField] of Object.entries(EVIDENCE_FIELD_MAP)) {
      const incoming = (payload as unknown as Record<string, number[] | undefined>)[requestField] ?? [];
      if (incoming.length === 0) continue;
      const existingIds = (existing[schemaField] ?? []).map((m) => m.id);
      updateData[schemaField] = Array.from(new Set([...existingIds, ...incoming]));
    }

    return strapi.entityService.update("api::listing-verification.listing-verification" as any, verificationId, { data: updateData });
  },

  async applyDecision(verificationId: number, adminUserId: number, decision: VerificationDecisionRequest) {
    const verification = (await strapi.entityService.findOne(
      "api::listing-verification.listing-verification" as any,
      verificationId,
      { populate: { product: { fields: ["id"] } } },
    )) as unknown as { product?: { id: number } | null } | null;

    if (!verification?.product?.id) throw new VerificationNotFoundError("Verification record or linked product not found.");

    const statusMap = { approve: "approved", reject: "rejected", request_more_evidence: "more_evidence_requested" } as const;
    const newStatus = statusMap[decision.decision];

    await strapi.entityService.update("api::listing-verification.listing-verification" as any, verificationId, {
      data: { status: newStatus, adminNotes: decision.adminNotes, reviewedBy: adminUserId, reviewedAt: new Date().toISOString() },
    });

    const productUpdate: Record<string, unknown> = {};
    if (decision.decision === "approve") { productUpdate.productStatus = "active"; productUpdate.isVerifiedLuxury = true; }
    else if (decision.decision === "reject") { productUpdate.productStatus = "hidden"; productUpdate.isVerifiedLuxury = false; }

    if (Object.keys(productUpdate).length > 0) {
      await strapi.entityService.update("api::product.product", verification.product.id, { data: productUpdate });
    }

    // TODO(developer): wire in the existing createNotification helper here to notify the seller of the decision.
    // import { createNotification } from "../../../lib/createNotification";
    // await createNotification({ ... });

    return { productId: verification.product.id, status: newStatus };
  },
});
