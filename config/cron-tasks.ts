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

        // Unreserve product
        if (offer.product?.id) {
          await strapi.entityService.update(
            "api::product.product",
            offer.product.id,
            { data: { productStatus: "active" } }
          );
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
