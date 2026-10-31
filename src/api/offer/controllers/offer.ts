import { factories } from "@strapi/strapi";

const MIN_RATIO = 0.5; // offer must be >= 50% of original price
const MAX_RATIO = 1.5; // offer must be <= 150% of original price
const OFFER_EXPIRY_HOURS = 48; // Offer expires after 48 hours of acceptance
const OFFER_POPULATE = {
  product: {
    populate: {
      users_permissions_user: { fields: ["id", "username"] },
    },
  },
  buyer: { fields: ["id", "username"] },
  seller: { fields: ["id", "username"] },
  sender: { fields: ["id", "username"] },
  conversation: { fields: ["id"] },
};

async function getAuthenticatedUserId(strapi: any, ctx: any): Promise<number | null> {
  const stateId = Number(ctx?.state?.user?.id);
  if (Number.isInteger(stateId) && stateId > 0) return stateId;
  const authorization = String(ctx?.request?.headers?.authorization ?? "");
  if (!authorization.startsWith("Bearer ")) return null;
  try {
    const payload = await strapi.plugin("users-permissions").service("jwt").verify(authorization.slice(7).trim());
    const id = Number(payload?.id);
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

async function createOfferChatMessage(strapi: any, conversationId: number, data: any) {
  const message = await strapi.entityService.create("api::message.message" as any, {
    data: { ...data, conversation: conversationId },
    populate: {
      sender: { fields: ["id", "username"], populate: { avatar: { fields: ["url"] } } },
      offer: {
        populate: {
          buyer: { fields: ["id", "username"] },
          seller: { fields: ["id", "username"] },
  sender: { fields: ["id", "username"] },
          product: { fields: ["id", "documentId", "title", "price", "productStatus"] },
        },
      },
    },
  }) as any;

  const offer = message.offer;
  const event = {
    id: message.id,
    conversationId,
    content: message.content ?? "",
    createdAt: message.createdAt ?? new Date().toISOString(),
    sender: message.sender
      ? { id: message.sender.id, username: message.sender.username, avatar: message.sender.avatar ?? null }
      : null,
    attachments: [],
    metadata: message.metadata ?? undefined,
    offer: offer
      ? {
          id: offer.id,
          offerPrice: offer.offerPrice,
          editedAt: offer.editedAt ?? null,
          editCount: offer.editCount ?? 0,
          seenAt: offer.seenAt ?? null,
          originalPrice: offer.originalPrice,
          status: offer.status,
          productTitle: offer.productTitle ?? offer.product?.title ?? null,
          productImage: offer.productImage ?? null,
          product: offer.product
            ? {
                id: offer.product.id,
                documentId: offer.product.documentId ?? null,
                title: offer.product.title ?? null,
                price: offer.product.price ?? null,
                productStatus: offer.product.productStatus ?? null,
              }
            : null,
          buyer: offer.buyer ? { id: offer.buyer.id, username: offer.buyer.username } : null,
          seller: offer.seller ? { id: offer.seller.id, username: offer.seller.username } : null,
        }
      : undefined,
  };

  const io = (strapi as any).io;
  if (io) {
    const buyerId = Number(offer?.buyer?.id);
    const sellerId = Number(offer?.seller?.id);
    let target = io.to(`conversation:${conversationId}`);
    if (buyerId) target = target.to(`user:${buyerId}`);
    if (sellerId) target = target.to(`user:${sellerId}`);
    target.emit("message:new", event);
  }

  return message;
}

export default factories.createCoreController(
  "api::offer.offer",
  ({ strapi }) => ({
    // POST /api/offers/make
    async makeOffer(ctx: any) {
      const { productId, buyerId, sellerId, offerPrice, message, conversationId, parentOfferId } =
        ctx.request.body;

      if (!productId || !buyerId || !offerPrice) {
        return ctx.badRequest("Missing required fields: productId, buyerId, and offerPrice are required.");
      }

      if (!sellerId) {
        return ctx.badRequest("This product does not have a seller associated with it. Cannot make an offer.");
      }
      const authenticatedUserId = await getAuthenticatedUserId(strapi, ctx);
      if (!authenticatedUserId) return ctx.unauthorized("Authentication required.");
      if (authenticatedUserId !== Number(buyerId) && authenticatedUserId !== Number(sellerId)) {
        return ctx.forbidden("You must be a participant in this offer.");
      }

      const product = await strapi.entityService.findOne(
        "api::product.product",
        productId,
        { populate: ["images", "users_permissions_user"] }
      );

      if (!product) return ctx.notFound("Product not found.");

      const productSellerId = Number((product as any).users_permissions_user?.id ?? (product as any).users_permissions_user);
      if (!productSellerId) {
        return ctx.badRequest("This product does not have a valid seller.");
      }
      if (productSellerId !== Number(sellerId)) {
        const parentId = Number(parentOfferId);
        const parent = Number.isInteger(parentId) && parentId > 0
          ? await strapi.entityService.findOne("api::offer.offer" as any, parentId, {
              populate: { product: { fields: ["id"] }, buyer: { fields: ["id"] }, seller: { fields: ["id"] } },
            }) as any
          : null;
        const validCounter = parent &&
          Number(parent.product?.id) === Number(productId) &&
          Number(parent.seller?.id) === productSellerId &&
          Number(parent.buyer?.id) === Number(sellerId) &&
          Number(buyerId) === productSellerId &&
          ["pending", "declined"].includes(parent.status);
        if (!validCounter) {
          return ctx.badRequest("Seller does not match this product.");
        }
      }

      // A supplied conversation is valid only for these two participants.
      // This remains true for counteroffers, where buyer/seller roles reverse.
      if (conversationId) {
        const conversation = await strapi.entityService.findOne(
          "api::conversation.conversation" as any,
          Number(conversationId),
          { populate: { buyer: { fields: ["id"] }, seller: { fields: ["id"] } } },
        ) as any;
        if (!conversation) return ctx.notFound("Conversation not found.");
        const participants = [Number(conversation.buyer?.id), Number(conversation.seller?.id)].sort((a, b) => a - b);
        const offerParticipants = [Number(buyerId), Number(sellerId)].sort((a, b) => a - b);
        if (participants[0] !== offerParticipants[0] || participants[1] !== offerParticipants[1]) {
          return ctx.badRequest("Conversation does not match the offer participants.");
        }
      }

      const productStatus = (product as any).productStatus;
      if (productStatus === 'sold' || productStatus === 'reserved') {
        return ctx.badRequest('This item is no longer available for offers.');
      }

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

      // Decline any existing pending offer from same buyer on same product
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
        // Update the existing pending offer price instead of creating a new one
        const existingOffer = (existing as any[])[0];
        const updatedOffer = await strapi.entityService.update(
          "api::offer.offer" as any,
          existingOffer.id,
          { data: { offerPrice, message: message ?? null, conversation: conversationId ?? existingOffer.conversation ?? null } }
        );
        const populatedUpdated = await strapi.entityService.findOne(
          "api::offer.offer" as any,
          existingOffer.id,
          { populate: OFFER_POPULATE }
        );
        return ctx.send({ data: populatedUpdated ?? updatedOffer });
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
          sender: authenticatedUserId,
          productTitle: (product as any).title,
          productImage: firstImage,
          conversation: conversationId ?? null,
        },
      });

      // Fire-and-forget: chat message + notification (don't block the response)
      setImmediate(async () => {
        try {
          if (conversationId) {
            await createOfferChatMessage(strapi, Number(conversationId), {
                sender: buyerId,
                content: `Made an offer: THB${offerPrice}${message ? ` - "${message}"` : ''}`,
                offer: offer.id,
                metadata: {
                  type: 'offer',
                  offerId: offer.id,
                  amount: offerPrice,
                  status: 'pending',
                  // Product identity travels with the offer, not the conversation:
                  // one conversation can hold offers for several products.
                  productId: (offer as any).product?.id ?? productId,
                  productTitle: (offer as any).productTitle ?? (product as any).title,
                  productImage: (offer as any).productImage ?? firstImage,
                },
            });
            await strapi.entityService.update('api::conversation.conversation' as any, Number(conversationId), {
              data: {
                lastMessageAt: new Date().toISOString(),
                lastMessagePreview: 'Offer sent',
              },
            });
          }
          await strapi.entityService.create('api::notification.notification' as any, {
            data: {
              type: 'offer_received',
              title: 'New Offer Received',
              body: `You received an offer of THB ${offerPrice} on "${(product as any).title}".`,
              read: false,
              link: `/Orders?tab=offers`,
              recipient: sellerId,
            },
          });
        } catch (e) {
          strapi.log.error('makeOffer background tasks failed:', e);
        }
      });

      const populatedOffer = await strapi.entityService.findOne(
        "api::offer.offer" as any,
        (offer as any).id,
        { populate: OFFER_POPULATE }
      );

      return ctx.created({ data: populatedOffer ?? offer });
    },

    // GET /api/offers/seller/:sellerId
    async getOffersForSeller(ctx: any) {
      const sellerId = Number(ctx.params.sellerId);
      if (!sellerId) return ctx.badRequest("sellerId is required.");

      const offers = await strapi.entityService.findMany(
        "api::offer.offer" as any,
        {
          filters: { seller: { id: sellerId } },
          populate: OFFER_POPULATE,
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
          populate: OFFER_POPULATE,
          sort: { createdAt: "desc" },
          limit: 50,
        }
      );

      return ctx.send({ data: offers });
    },

    // PATCH /api/offers/:id/respond
    async respondToOffer(ctx: any) {
      const offerId = Number(ctx.params.id);
      const { action, sellerId, conversationId } = ctx.request.body; // action: "accepted" | "declined"

      if (!offerId || !action || !sellerId) {
        return ctx.badRequest("offerId, action, and sellerId are required.");
      }
      if (!["accepted", "declined"].includes(action)) {
        return ctx.badRequest('action must be "accepted" or "declined".');
      }

      const offer = await strapi.entityService.findOne(
        "api::offer.offer" as any,
        offerId,
        { populate: OFFER_POPULATE }
      );

      if (!offer) return ctx.notFound("Offer not found.");
      const authenticatedUserId = await getAuthenticatedUserId(strapi, ctx);
      if (!authenticatedUserId) return ctx.unauthorized("Authentication required.");
      if (authenticatedUserId !== Number((offer as any).seller?.id))
        return ctx.forbidden("Only the offer seller can respond.");
      if (Number((offer as any).seller?.id) !== Number(sellerId))
        return ctx.forbidden("Not your offer.");
      if ((offer as any).status !== "pending")
        return ctx.send({ data: offer, alreadyResponded: true }); // already responded — return current state

      const productId = (offer as any).product?.id;

      // For acceptance: validate product is still available. The listing stays
      // active until an order is successfully placed.
      if (action === "accepted" && productId) {
        const product = await strapi.entityService.findOne(
          "api::product.product",
          productId,
          { fields: ["productStatus"] }
        ) as any;

        if (!product) return ctx.notFound("Product not found.");

        if (product.productStatus === "sold" || product.productStatus === "reserved") {
          // Product already taken — mark this offer unavailable and return conflict
          await strapi.entityService.update("api::offer.offer" as any, offerId, {
            data: { status: "unavailable" },
          });
          const unavailableOffer = await strapi.entityService.findOne(
            "api::offer.offer" as any, offerId, { populate: OFFER_POPULATE }
          );
          return ctx.send({
            data: unavailableOffer,
            conflict: true,
            message: "This item is no longer available.",
          });
        }

      }

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
      const populatedUpdated = await strapi.entityService.findOne(
        "api::offer.offer" as any,
        offerId,
        { populate: OFFER_POPULATE }
      );

      const buyerId = (offer as any).buyer?.id;
      const productTitle = (offer as any).productTitle ?? 'the product';
      const offerPrice = (offer as any).offerPrice;

      // Acceptance is per offer. Competing offers remain actionable until the
      // order endpoint atomically confirms a successful purchase.
      // Fire-and-forget chat message and notification.
      setImmediate(async () => {
        try {
          const offerConversationId = (offer as any).conversation?.id;
          if (offerConversationId) {
            await createOfferChatMessage(strapi, Number(offerConversationId), {
                sender: sellerId,
                content: action === 'accepted' ? 'Offer Accepted' : 'Offer Declined',
                offer: offerId,
                metadata: {
                  type: 'offer_response',
                  offerId,
                  action,
                  status: action,
                  productId,
                  productTitle: (offer as any).productTitle,
                },
            });
            await strapi.entityService.update('api::conversation.conversation' as any, Number(offerConversationId), {
              data: {
                lastMessageAt: new Date().toISOString(),
                lastMessagePreview: action === 'accepted' ? 'Offer accepted' : 'Offer declined',
              },
            });
          }
          await strapi.entityService.create('api::notification.notification' as any, {
            data: {
              type: action === 'accepted' ? 'offer_accepted' : 'offer_declined',
              title: action === 'accepted' ? 'Offer Accepted! 🎉' : 'Offer Declined',
              body: action === 'accepted'
                ? `Your offer of THB ${offerPrice} on "${productTitle}" was accepted! You have 48 hours to complete the purchase.`
                : `Your offer on "${productTitle}" was declined by the seller.`,
              read: false,
              link: action === 'accepted'
                ? `/Orders?tab=offers&highlight=${offerId}`
                : `/products/${productId}`,
              recipient: buyerId,
            },
          });
        } catch (e) {
          strapi.log.error('respondToOffer background tasks failed:', e);
        }
      });

      return ctx.send({
        data: populatedUpdated ?? updated,
      });
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
        { populate: { ...OFFER_POPULATE, order: { fields: ["id"] } } }
      );

      if (!offer) return ctx.notFound("Offer not found.");
      if (!["accepted", "completed"].includes((offer as any).status))
        return ctx.badRequest("Offer is not in accepted state.");

      const order = await strapi.entityService.findOne(
        "api::order.order" as any,
        Number(orderId),
        { populate: ["buyer", "product"] }
      );
      if (!order) return ctx.notFound("Order not found.");
      if (Number((order as any).buyer?.id) !== Number(buyerId))
        return ctx.forbidden("This order does not belong to you.");
      if (
        Number((order as any).product?.id) !== Number((offer as any).product?.id)
      ) {
        return ctx.badRequest("The order product does not match this offer.");
      }

      const isOfferParticipant =
        Number((offer as any).buyer?.id) === Number(buyerId) ||
        Number((offer as any).seller?.id) === Number(buyerId);
      if (!isOfferParticipant)
        return ctx.forbidden("You are not part of this offer.");

      if ((offer as any).status === "completed") {
        if (Number((offer as any).order?.id) === Number(orderId)) {
          return ctx.send({ ok: true });
        }
        return ctx.badRequest("This offer has already been completed with another order.");
      }

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

    // PATCH /api/offers/:id
    async editOfferPrice(ctx: any) {
      const offerId = Number(ctx.params.id);
      if (!Number.isInteger(offerId) || offerId <= 0) {
        return ctx.badRequest("Invalid offer id.");
      }

      const authenticatedUserId = await getAuthenticatedUserId(strapi, ctx);
      if (!authenticatedUserId) {
        return ctx.unauthorized("Authentication required.");
      }

      const rawPrice = ctx.request.body?.offerPrice ?? ctx.request.body?.price;
      const numPrice = Number(rawPrice);
      if (!Number.isFinite(numPrice) || numPrice <= 0) {
        return ctx.badRequest("Price must be a valid number greater than zero.");
      }

      // Safe decimal handling (2 decimal places)
      const newPrice = Number(numPrice.toFixed(2));

      // Guard: Disallow updating unauthorized fields
      const allowedBodyKeys = new Set(["offerPrice", "price", "conversationId"]);
      for (const key of Object.keys(ctx.request.body || {})) {
        if (!allowedBodyKeys.has(key)) {
          return ctx.badRequest(`Field '${key}' cannot be modified.`);
        }
      }

      let updatedOffer: any;
      let updatedMessage: any;
      let finalConversationId: number | null = null;
      let buyerId: number | null = null;
      let sellerId: number | null = null;

      try {
        await strapi.db.transaction(async (trx: any) => {
          // 1. Load the offer and required relations atomically inside transaction
          const offer = await strapi.db.query("api::offer.offer").findOne({
            where: { id: offerId },
            populate: {
              product: { populate: { users_permissions_user: true } },
              buyer: true,
              seller: true,
              sender: true,
              conversation: true,
              order: true,
            },
          });

          if (!offer) {
            const err: any = new Error("Offer not found.");
            err.status = 404;
            throw err;
          }

          // 2. Conversation validation if provided
          const reqConvId = Number(ctx.request.body?.conversationId);
          if (Number.isInteger(reqConvId) && reqConvId > 0 && offer.conversation?.id) {
            if (Number(offer.conversation.id) !== reqConvId) {
              const err: any = new Error("Offer does not belong to this conversation.");
              err.status = 400;
              throw err;
            }
          }
          finalConversationId = offer.conversation ? Number(offer.conversation.id) : (Number.isInteger(reqConvId) ? reqConvId : null);
          buyerId = offer.buyer ? Number(offer.buyer.id) : null;
          sellerId = offer.seller ? Number(offer.seller.id) : null;

          // 3. Verify original sender ownership
          let offerSenderId = offer.sender ? Number(offer.sender.id) : null;

          // Find the chat message linked to this offer
          const messages = await strapi.db.query("api::message.message").findMany({
            where: { offer: { id: offerId } },
            populate: { sender: true },
            limit: 1,
          });
          const message = messages?.[0];

          if (!offerSenderId && message?.sender) {
            offerSenderId = Number(message.sender.id);
          }
          if (!offerSenderId && offer.buyer) {
            offerSenderId = Number(offer.buyer.id);
          }

          if (offerSenderId !== authenticatedUserId) {
            const err: any = new Error("You can only edit offers you have sent.");
            err.status = 403;
            throw err;
          }

          // 4. Validate offer status
          if (["accepted", "declined"].includes(offer.status)) {
            const err: any = new Error("This offer has already been responded to.");
            err.status = 400;
            throw err;
          }
          if (offer.status !== "pending") {
            const err: any = new Error("This offer is no longer available for editing.");
            err.status = 400;
            throw err;
          }

          // Check offer expiry
          if (offer.expiresAt && new Date(offer.expiresAt).getTime() <= Date.now()) {
            const err: any = new Error("This offer is no longer available for editing.");
            err.status = 400;
            throw err;
          }

          // 5. Validate that no response or order has occurred
          if (offer.acceptedAt || offer.order) {
            const err: any = new Error("This offer has already been responded to.");
            err.status = 400;
            throw err;
          }

          // 6. Validate recipient seen status
          if (offer.seenAt) {
            const err: any = new Error("You cannot edit this offer because the recipient has already viewed it.");
            err.status = 400;
            throw err;
          }

          if (message && message.readAt) {
            const err: any = new Error("You cannot edit this offer because the recipient has already viewed it.");
            err.status = 400;
            throw err;
          }

          if (!message && !offer.seenAt) {
            // Cannot establish accurate seen status for this offer
            const err: any = new Error("This offer is no longer available for editing.");
            err.status = 400;
            throw err;
          }

          // 7. Validate product availability
          const product = await strapi.db.query("api::product.product").findOne({
            where: { id: offer.product?.id },
          });
          if (!product || product.productStatus === "sold" || product.productStatus === "reserved" || product.productStatus === "hidden") {
            const err: any = new Error("This product is no longer available.");
            err.status = 400;
            throw err;
          }

          // 8. Validate the new price
          const currentOfferPrice = Number(offer.offerPrice);
          if (newPrice === currentOfferPrice) {
            const err: any = new Error("Offer price cannot be the same as the current offer price.");
            err.status = 400;
            throw err;
          }

          const originalPrice = Number(offer.originalPrice ?? product.price);
          if (newPrice < originalPrice * MIN_RATIO) {
            const err: any = new Error(`Offer is too low. Minimum offer is ${(originalPrice * MIN_RATIO).toFixed(2)}.`);
            err.status = 400;
            throw err;
          }
          if (newPrice > originalPrice * MAX_RATIO) {
            const err: any = new Error(`Offer is too high. Maximum offer is ${(originalPrice * MAX_RATIO).toFixed(2)}.`);
            err.status = 400;
            throw err;
          }

          // 9. Update existing offer atomically
          const now = new Date().toISOString();
          const nextEditCount = (Number(offer.editCount) || 0) + 1;

          await strapi.db.query("api::offer.offer").update({
            where: { id: offerId },
            data: {
              offerPrice: newPrice,
              editedAt: now,
              editCount: nextEditCount,
            },
          });

          // 10. Update any existing message-level price snapshot
          if (message) {
            const newContent = `Made an offer: THB${newPrice}${offer.message ? ` - "${offer.message}"` : ''}`;
            const newMetadata = {
              ...(message.metadata || {}),
              amount: newPrice,
              offerPrice: newPrice,
              editedAt: now,
            };
            await strapi.db.query("api::message.message").update({
              where: { id: message.id },
              data: {
                content: newContent,
                metadata: newMetadata,
              },
            });
            updatedMessage = {
              ...message,
              content: newContent,
              metadata: newMetadata,
            };
          }
        });
      } catch (err: any) {
        const status = err.status || 500;
        if (status === 400) return ctx.badRequest(err.message);
        if (status === 403) return ctx.forbidden(err.message);
        if (status === 404) return ctx.notFound(err.message);
        strapi.log.error("Failed to edit offer price:", err);
        return ctx.internalServerError("Failed to update offer price.");
      }

      // Fetch freshly populated offer
      const populated = await strapi.entityService.findOne(
        "api::offer.offer" as any,
        offerId,
        { populate: OFFER_POPULATE }
      );

      // Notify connected clients of the successful update
      const io = (strapi as any).io;
      if (io) {
        const updatePayload = {
          offerId,
          conversationId: finalConversationId,
          price: newPrice,
          offerPrice: newPrice,
          status: "pending",
          editedAt: (populated as any)?.editedAt,
          editCount: (populated as any)?.editCount,
          offer: populated,
          message: updatedMessage,
        };

        if (finalConversationId) {
          io.to(`conversation:${finalConversationId}`).emit("offer:updated", updatePayload);
        }
        if (buyerId) {
          io.to(`user:${buyerId}`).emit("offer:updated", updatePayload);
        }
        if (sellerId && sellerId !== buyerId) {
          io.to(`user:${sellerId}`).emit("offer:updated", updatePayload);
        }
      }

      return ctx.send({ ok: true, data: populated });
    },

    // PATCH /api/offers/:id/seen
    async markOfferSeen(ctx: any) {
      const offerId = Number(ctx.params.id);
      if (!Number.isInteger(offerId) || offerId <= 0) {
        return ctx.badRequest("Invalid offer id.");
      }

      const authenticatedUserId = await getAuthenticatedUserId(strapi, ctx);
      if (!authenticatedUserId) {
        return ctx.unauthorized("Authentication required.");
      }

      const offer = await strapi.entityService.findOne(
        "api::offer.offer" as any,
        offerId,
        { populate: OFFER_POPULATE }
      ) as any;

      if (!offer) return ctx.notFound("Offer not found.");

      // Check if user is recipient (either buyer or seller who did not send it)
      const senderId = offer.sender?.id ? Number(offer.sender.id) : (offer.buyer?.id ? Number(offer.buyer.id) : null);
      if (senderId && authenticatedUserId === senderId) {
        // Sender viewing their own offer does not mark as seen
        return ctx.send({ ok: true, alreadySeen: false });
      }

      const isBuyer = offer.buyer && Number(offer.buyer.id) === authenticatedUserId;
      const isSeller = offer.seller && Number(offer.seller.id) === authenticatedUserId;
      if (!isBuyer && !isSeller) {
        return ctx.forbidden("Not a participant in this offer.");
      }

      if (offer.seenAt) {
        return ctx.send({ ok: true, alreadySeen: true });
      }

      const now = new Date().toISOString();
      await strapi.entityService.update("api::offer.offer" as any, offerId, {
        data: { seenAt: now },
      });

      // Also mark the associated message as read if unread
      const messages = await strapi.entityService.findMany("api::message.message" as any, {
        filters: { offer: { id: offerId } },
        limit: 1,
      }) as any[];
      if (messages?.[0] && !messages[0].readAt) {
        await strapi.entityService.update("api::message.message" as any, messages[0].id, {
          data: { readAt: now },
        });
      }

      // Emit offer:seen event to notify sender and conversation
      const io = (strapi as any).io;
      if (io) {
        const conversationId = offer.conversation?.id;
        const seenPayload = {
          offerId,
          conversationId,
          seenAt: now,
          seenBy: authenticatedUserId,
        };
        if (conversationId) {
          io.to(`conversation:${conversationId}`).emit("offer:seen", seenPayload);
        }
        if (senderId) {
          io.to(`user:${senderId}`).emit("offer:seen", seenPayload);
        }
      }

      return ctx.send({ ok: true, seenAt: now });
    },

  })
);
