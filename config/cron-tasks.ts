module.exports = {
  /**
   * Cron job to check and expire offers every hour
   */
  "0 * * * *": async ({ strapi }: { strapi: any }) => {
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

  /**
   * Cron job to check 48-hour dispute window expiration and mark seller payout ELIGIBLE
   * Runs every 5 minutes (Idempotent and safe to rerun)
   */
  "*/5 * * * *": async ({ strapi }: { strapi: any }) => {
    try {
      const now = new Date();
      const deliveredOrders = (await strapi.entityService.findMany(
        "api::order.order",
        {
          filters: {
            orderStatus: { $in: ["delivered", "DELIVERED"] },
            deliveredAt: { $notNull: true },
          } as any,
          populate: { buyer: true, seller: true },
        }
      )) as any[];

      for (const order of deliveredOrders) {
        const deliveredTime = new Date(order.deliveredAt).getTime();
        const disputeDeadlineTime = order.disputeDeadline
          ? new Date(order.disputeDeadline).getTime()
          : deliveredTime + 48 * 60 * 60 * 1000;

        if (now.getTime() >= disputeDeadlineTime) {
          const disputes = (await strapi.entityService.findMany(
            "api::dispute.dispute",
            {
              filters: { order: { id: order.id } } as any,
            }
          )) as any[];

          const hasActiveDispute = disputes.some((d: any) =>
            ["OPEN", "UNDER_REVIEW", "AWAITING_INFORMATION"].includes(
              (d.status || "").toUpperCase()
            )
          );

          const isRefunded =
            (order.paymentStatus || "").toLowerCase() === "refunded" ||
            disputes.some(
              (d: any) => (d.status || "").toUpperCase() === "RESOLVED_REFUND"
            );

          const currentPayoutStatus = (order.payoutStatus || "").toUpperCase();
          const alreadyProcessed = [
            "PAID",
            "PROCESSING",
            "TRANSFERRED",
          ].includes(currentPayoutStatus);

          if (!alreadyProcessed && !isRefunded) {
            if (hasActiveDispute) {
              if (currentPayoutStatus !== "ON_HOLD") {
                await strapi.entityService.update(
                  "api::order.order",
                  order.id,
                  {
                    data: { payoutStatus: "ON_HOLD" } as any,
                  }
                );
                strapi.log.info(
                  `[CRON] Order #${order.id} payout placed ON_HOLD due to active dispute`
                );
              }
            } else {
              if (
                currentPayoutStatus !== "ELIGIBLE" ||
                order.disputeWindowStatus !== "CLOSED"
              ) {
                await strapi.entityService.update(
                  "api::order.order",
                  order.id,
                  {
                    data: {
                      disputeWindowStatus: "CLOSED",
                      payoutStatus: "ELIGIBLE",
                      payoutEligibleAt: new Date(
                        disputeDeadlineTime
                      ).toISOString(),
                    } as any,
                  }
                );
                strapi.log.info(
                  `[CRON] Order #${order.id} marked ELIGIBLE for seller payout (48h passed, no disputes)`
                );
              }
            }
          }
        }
      }
    } catch (error) {
      strapi.log.error(
        "[CRON] Error evaluating 48h dispute window eligibility:",
        error
      );
    }
  },
};
