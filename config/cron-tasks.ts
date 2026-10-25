module.exports = {
  /**
   * Cron job to check and expire offers every hour
   */
  "0 * * * *": async ({ strapi }) => {
    try {
      const now = new Date();
      const expiredOffers = await strapi.entityService.findMany(
        "api::offer.offer",
        {
          filters: {
            status: "accepted",
            expiresAt: { $lt: now.toISOString() },
          },
          populate: ["product"],
          limit: 100,
        }
      );

      let expiredCount = 0;
      for (const offer of expiredOffers) {
        await strapi.entityService.update("api::offer.offer", offer.id, {
          data: { status: "expired" },
        });

        // Unreserve product, but never resurrect a product that has been
        // purchased (productStatus is authoritative after a confirmed sale).
        if (offer.product?.id) {
          const product = await strapi.entityService.findOne(
            "api::product.product",
            offer.product.id,
            { fields: ["productStatus"] }
          );
          if (product && product.productStatus !== "sold") {
            await strapi.entityService.update(
              "api::product.product",
              offer.product.id,
              { data: { productStatus: "active" } }
            );
          }
        }

        expiredCount++;
      }

      if (expiredCount > 0) {
        strapi.log.info(`[CRON] Expired ${expiredCount} offers`);
      }
    } catch (error) {
      strapi.log.error("[CRON] Error expiring offers:", error);
    }
  },
};
