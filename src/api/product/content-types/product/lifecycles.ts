import type { Core } from "@strapi/strapi";

interface LuxuryBrandConfigRow {
  id: number;
  requiredEvidenceTypes: unknown;
}

export default {
  async afterCreate(event: { result: { id: number } }) {
    const strapi = global.strapi as Core.Strapi;
    const productId = event.result.id;

    try {
      const product = (await strapi.entityService.findOne("api::product.product" as any, productId, {
        populate: { brand: { fields: ["id"] } },
      })) as unknown as { brand?: { id: number } | null } | null;

      const brandId = product?.brand?.id ?? null;
      if (!brandId) return;

      const configRows = (await strapi.entityService.findMany(
        "api::luxury-brand-config.luxury-brand-config" as any,
        {
          filters: { brand: { id: { $eq: brandId } }, isActive: { $eq: true } },
          fields: ["id", "requiredEvidenceTypes"],
          limit: 1,
        },
      )) as unknown as LuxuryBrandConfigRow[];

      const config = configRows[0];
      if (!config) return;

      await strapi.entityService.update("api::product.product" as any, productId, {
        data: { productStatus: "draft" },
      });

      await strapi.entityService.create("api::listing-verification.listing-verification" as any, {
        data: {
          product: productId,
          status: "pending",
          luxury_brand_config: config.id,
          requiredEvidenceTypesSnapshot: config.requiredEvidenceTypes as any,
          missingEvidence: Array.isArray(config.requiredEvidenceTypes) ? (config.requiredEvidenceTypes as any[]) : [],
        },
      });
    } catch (error) {
      strapi.log.error(
        `[product.lifecycles.afterCreate] Failed to apply luxury verification gate for product ${productId}. This product may need manual review: ${(error as Error).message}`,
      );
    }
  },
};
