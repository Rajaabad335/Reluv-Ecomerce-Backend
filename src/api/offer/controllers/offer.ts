import { factories } from "@strapi/strapi";

const MIN_RATIO = 0.5; // offer must be >= 50% of original price
const MAX_RATIO = 1.5; // offer must be <= 150% of original price
const OFFER_EXPIRY_HOURS = 48; // Offer expires after 48 hours of acceptance

export default factories.createCoreController(
  "api::offer.offer",
  ({ strapi }) => ({
    // POST /api/offers/make
    async makeOffer(ctx: any) {
      const { productId, buyerId, sellerId, offerPrice, message } =
        ctx.request.body;

      if (!productId || !buyerId || !offerPrice) {
        return ctx.badRequest("Missing required fields: productId, buyerId, and offerPrice are required.");
      }

      if (!sellerId) {
        return ctx.badRequest("This product does not have a seller associated with it. Cannot make an offer.");
      }

      const product = await strapi.entityService.findOne(
        "api::product.product",
        productId,
        { populate: ["images"] }
      );

      if (!product) return ctx.notFound("Product not found.");

      const originalPrice = (product as any).price;

      if (offerPrice < originalPrice * MIN_RATIO) {
        return ctx.badRequest(
          `Offer is too low. Minimum offer is ${(originalPrice * MIN_RATIO).toFixed(2)}.`
        );
      }
      if (offerPrice > originalPrice * MAX_RATIO) {
        return ctx.badRequest(
          `Offer is too high. Maximum offer is ${(originalPrice * MAX_RATIO).toFixed(2)}.`
        );
      }

      // Check for existing pending offer from same buyer on same product
      const existing = await strapi.entityService.findMany(
        "api::offer.offer" as any,
        {
          filters: {
            product: { id: productId },
            buyer: { id: buyerId },
            status: "pending",
          },
          limit: 1,
        }
      );

      if ((existing as any[]).length > 0) {
        return ctx.badRequest(
          "You already have a pending offer on this product."
        );
      }

      const images = (product as any).images ?? [];
      const firstImage =
        images[0]?.url ?? images[0]?.formats?.thumbnail?.url ?? null;

      const offer = await strapi.entityService.create("api::offer.offer" as any, {
        data: {
          offerPrice,
          originalPrice,
          message: message ?? null,
          status: "pending",
          product: productId,
          buyer: buyerId,
          seller: sellerId,
          productTitle: (product as any).title,
          productImage: firstImage,
        },
      });

      // Notify seller
      await strapi.entityService.create(
        "api::notification.notification" as any,
        {
          data: {
            type: "offer_received",
            title: "New Offer Received",
            body: `You received an offer of ${offerPrice} on "${(product as any).title}".`,
            read: false,
            link: `/Orders?tab=offers`,
            recipient: sellerId,
          },
        }
      );

      return ctx.created({ data: offer });
    },

    // GET /api/offers/seller/:sellerId
    async getOffersForSeller(ctx: any) {
      const sellerId = Number(ctx.params.sellerId);
      if (!sellerId) return ctx.badRequest("sellerId is required.");

      const offers = await strapi.entityService.findMany(
        "api::offer.offer" as any,
        {
          filters: { seller: { id: sellerId } },
          populate: ["product", "buyer", "seller"],
          sort: { createdAt: "desc" },
          limit: 50,
        }
      );

      return ctx.send({ data: offers });
    },

    // GET /api/offers/buyer/:buyerId
    async getOffersForBuyer(ctx: any) {
      const buyerId = Number(ctx.params.buyerId);
      if (!buyerId) return ctx.badRequest("buyerId is required.");

      const offers = await strapi.entityService.findMany(
        "api::offer.offer" as any,
        {
          filters: { buyer: { id: buyerId } },
          populate: ["product", "buyer", "seller"],
          sort: { createdAt: "desc" },
          limit: 50,
        }
      );

      return ctx.send({ data: offers });
    },

    // PATCH /api/offers/:id/respond
    async respondToOffer(ctx: any) {
      const offerId = Number(ctx.params.id);
      const { action, sellerId } = ctx.request.body; // action: "accepted" | "declined"

      if (!offerId || !action || !sellerId) {
        return ctx.badRequest("offerId, action, and sellerId are required.");
      }
      if (!["accepted", "declined"].includes(action)) {
        return ctx.badRequest('action must be "accepted" or "declined".');
      }

      const offer = await strapi.entityService.findOne(
        "api::offer.offer" as any,
        offerId,
        { populate: ["product", "buyer", "seller"] }
      );

      if (!offer) return ctx.notFound("Offer not found.");
      if ((offer as any).seller?.id !== sellerId)
        return ctx.forbidden("Not your offer.");
      if ((offer as any).status !== "pending")
        return ctx.badRequest("Offer is no longer pending.");

      const now = new Date();
      const expiresAt = new Date(now.getTime() + OFFER_EXPIRY_HOURS * 60 * 60 * 1000);

      const updated = await strapi.entityService.update(
        "api::offer.offer" as any,
        offerId,
        {
          data: {
            status: action,
            acceptedAt: action === "accepted" ? now.toISOString() : null,
            expiresAt: action === "accepted" ? expiresAt.toISOString() : null,
          },
        }
      );

      const buyerId = (offer as any).buyer?.id;
      const productTitle = (offer as any).productTitle ?? "the product";
      const offerPrice = (offer as any).offerPrice;
      const productId = (offer as any).product?.id;

      // Notify buyer
      await strapi.entityService.create(
        "api::notification.notification" as any,
        {
          data: {
            type: action === "accepted" ? "offer_accepted" : "offer_declined",
            title:
              action === "accepted" ? "Offer Accepted! 🎉" : "Offer Declined",
            body:
              action === "accepted"
                ? `Your offer of ${offerPrice} on "${productTitle}" was accepted! You have 48 hours to complete the purchase.`
                : `Your offer on "${productTitle}" was declined by the seller.`,
            read: false,
            link:
              action === "accepted"
                ? `/Orders?tab=offers&highlight=${offerId}`
                : `/products/${productId}`,
            recipient: buyerId,
          },
        }
      );

      // If accepted, mark product as reserved
      if (action === "accepted" && productId) {
        await strapi.entityService.update("api::product.product", productId, {
          data: { productStatus: "reserved" },
        });
      }

      return ctx.send({ data: updated });
    },

    // POST /api/offers/:id/complete
    async completeOffer(ctx: any) {
      const offerId = Number(ctx.params.id);
      const { orderId, buyerId } = ctx.request.body;

      if (!offerId || !orderId || !buyerId) {
        return ctx.badRequest("offerId, orderId, and buyerId are required.");
      }

      const offer = await strapi.entityService.findOne(
        "api::offer.offer" as any,
        offerId,
        { populate: ["buyer", "product"] }
      );

      if (!offer) return ctx.notFound("Offer not found.");
      if ((offer as any).buyer?.id !== buyerId)
        return ctx.forbidden("Not your offer.");
      if ((offer as any).status !== "accepted")
        return ctx.badRequest("Offer is not in accepted state.");

      // Check if offer has expired
      const expiresAt = (offer as any).expiresAt;
      if (expiresAt && new Date(expiresAt) < new Date()) {
        await strapi.entityService.update(
          "api::offer.offer" as any,
          offerId,
          { data: { status: "expired" } }
        );
        return ctx.badRequest("This offer has expired.");
      }

      // Mark offer as completed and link to order
      await strapi.entityService.update(
        "api::offer.offer" as any,
        offerId,
        {
          data: {
            status: "completed",
            order: orderId,
          },
        }
      );

      return ctx.send({ ok: true });
    },

    // GET /api/offers/check-expiry (cron job endpoint)
    async checkExpiredOffers(ctx: any) {
      try {
        const now = new Date();
        const expiredOffers = await strapi.entityService.findMany(
          "api::offer.offer" as any,
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
        for (const offer of expiredOffers as any[]) {
          await strapi.entityService.update(
            "api::offer.offer" as any,
            offer.id,
            { data: { status: "expired" } }
          );

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

        return ctx.send({ ok: true, expiredCount });
      } catch (error) {
        strapi.log.error("Error checking expired offers:", error);
        return ctx.internalServerError("Failed to check expired offers.");
      }
    },
  })
);
