/**
 * order controller
 */

import { factories } from "@strapi/strapi";
import { createNotification } from "../../../lib/createNotification";
import { stripe } from "../../../utils/stripe";

export default factories.createCoreController(
  "api::order.order",
  ({ strapi }) => ({
    async createPaymentIntent(ctx) {
      try {
        const { body } = ctx.request as any;
        const { productId, buyerProtectionFee, shippingFee, currencyCode } =
          body;

        // Re-derive price from DB — do not trust client-sent price/total for the charge
        const product = await strapi.entityService.findOne(
          "api::product.product",
          productId,
        );
        if (!product) return ctx.badRequest("Product not found.");

        const amount =
          Number(product.price) +
          Number(buyerProtectionFee || 0) +
          Number(shippingFee || 0);
        const amountInMinorUnits = Math.round(amount * 100); // Stripe expects cents

        const paymentIntent = await stripe.paymentIntents.create({
          amount: amountInMinorUnits,
          currency: (currencyCode || "thb").toLowerCase(),
          metadata: {
            productId: String(productId),
            buyerId: String(body.buyerId),
            sellerId: String(body.sellerId),
          },
          automatic_payment_methods: { enabled: true },
        });

        return ctx.send({
          clientSecret: paymentIntent.client_secret,
          paymentIntentId: paymentIntent.id,
          amount,
        });
      } catch (error) {
        strapi.log.error("Error creating payment intent:", error);
        return ctx.internalServerError("Could not create payment intent.");
      }
    },
    async syncPaymentIntent(ctx) {
      try {
        const { body } = ctx.request as any;
        const {
          productId,
          buyerProtectionFee,
          shippingFee,
          currencyCode,
          paymentIntentId,
        } = body;

        const product = await strapi.entityService.findOne(
          "api::product.product",
          productId,
        );
        if (!product) return ctx.badRequest("Product not found.");

        const amount =
          Number(product.price) +
          Number(buyerProtectionFee || 0) +
          Number(shippingFee || 0);
        const amountInMinorUnits = Math.round(amount * 100);

        let paymentIntent;
        if (paymentIntentId) {
          paymentIntent = await stripe.paymentIntents.update(paymentIntentId, {
            amount: amountInMinorUnits,
          });
        } else {
          paymentIntent = await stripe.paymentIntents.create({
            amount: amountInMinorUnits,
            currency: (currencyCode || "thb").toLowerCase(),
            metadata: {
              productId: String(productId),
              buyerId: String(body.buyerId),
              sellerId: String(body.sellerId),
            },
            automatic_payment_methods: { enabled: true },
          });
        }

        return ctx.send({
          clientSecret: paymentIntent.client_secret,
          paymentIntentId: paymentIntent.id,
          amount,
        });
      } catch (error) {
        strapi.log.error("Error syncing payment intent:", error);
        return ctx.internalServerError("Could not prepare payment.");
      }
    },
    async placeOrder(ctx) {
      try {
        const { body } = ctx.request as any; // Type assertion to access body
        const authenticatedUserId = Number(ctx.state?.user?.id);
        if (authenticatedUserId && authenticatedUserId !== Number(body.buyerId)) {
          return ctx.forbidden("You can only place an order for the signed-in buyer.");
        }
        const product = await strapi.entityService.findOne(
          "api::product.product",
          body.productId,
          { fields: ["productStatus", "price"], populate: { users_permissions_user: { fields: ["id"] } } },
        ) as any;
        if (!product) return ctx.notFound("Product not found.");

        let acceptedOffer: any = null;
        if (body.offerId != null && body.offerId !== "") {
          const offerId = Number(body.offerId);
          if (!Number.isInteger(offerId) || offerId <= 0) {
            return ctx.badRequest("Invalid offer.");
          }
          acceptedOffer = await strapi.entityService.findOne(
            "api::offer.offer" as any,
            offerId,
            { populate: { product: { fields: ["id"] }, buyer: { fields: ["id"] }, seller: { fields: ["id"] } } },
          ) as any;
          if (!acceptedOffer || acceptedOffer.status !== "accepted") {
            return ctx.badRequest("This offer is no longer available for checkout.");
          }
          if (acceptedOffer.expiresAt && new Date(acceptedOffer.expiresAt).getTime() <= Date.now()) {
            await strapi.entityService.update("api::offer.offer" as any, offerId, {
              data: { status: "expired" },
            });
            return ctx.badRequest("This offer has expired.");
          }
          if (
            Number(acceptedOffer.product?.id) !== Number(body.productId)
          ) {
            return ctx.badRequest("The accepted offer does not match this order.");
          }
          const listingSellerId = Number(product.users_permissions_user?.id ?? product.users_permissions_user);
          const offerBuyerId = Number(acceptedOffer.buyer?.id);
          const offerSellerId = Number(acceptedOffer.seller?.id);
          const expectedBuyerId = offerBuyerId === listingSellerId ? offerSellerId : offerBuyerId;
          if (
            !listingSellerId ||
            ![offerBuyerId, offerSellerId].includes(listingSellerId) ||
            Number(body.sellerId) !== listingSellerId ||
            Number(body.buyerId) !== expectedBuyerId
          ) {
            return ctx.badRequest("The accepted offer participants do not match this order.");
          }
          // Keep compatibility with offers accepted before reservation was
          // removed; new accepted offers leave the product active. Do not
          // early-return here: the atomic product claim below is the single
          // authoritative sold check and answers with a clear conflict.
          if (!Number.isInteger(Number(product.id))) {
            return ctx.badRequest("This item is no longer available.");
          }
        } else {
          // Some checkout entry points can preserve the accepted price in the
          // URL while dropping offerId. Recover the buyer's accepted offer so
          // the listing can still be checked out at that price.
          const matchingOffers = await strapi.entityService.findMany(
            "api::offer.offer" as any,
            {
              filters: {
                product: { id: body.productId },
                buyer: { id: body.buyerId },
                status: "accepted",
              },
              populate: {
                product: { fields: ["id"] },
                buyer: { fields: ["id"] },
                seller: { fields: ["id"] },
              },
              limit: 2,
            },
          ) as any[];

          if (matchingOffers.length === 1) {
            acceptedOffer = matchingOffers[0];
            if (
              acceptedOffer.expiresAt &&
              new Date(acceptedOffer.expiresAt).getTime() <= Date.now()
            ) {
              await strapi.entityService.update("api::offer.offer" as any, acceptedOffer.id, {
                data: { status: "expired" },
              });
              return ctx.badRequest("This offer has expired.");
            }
            const offerBuyerId = Number(acceptedOffer.buyer?.id);
            const offerSellerId = Number(acceptedOffer.seller?.id);
            const listingSellerId = Number(product.users_permissions_user?.id ?? product.users_permissions_user);
            const expectedBuyerId = offerBuyerId === listingSellerId ? offerSellerId : offerBuyerId;
            if (
              !["active", "reserved"].includes(product.productStatus) ||
              !listingSellerId ||
              ![offerBuyerId, offerSellerId].includes(listingSellerId) ||
              Number(body.sellerId) !== listingSellerId ||
              Number(body.buyerId) !== expectedBuyerId
            ) {
              return ctx.badRequest("The accepted offer participants do not match this order.");
            }
          }
        }

        if (!acceptedOffer && product.productStatus !== "active") {
          if (product.productStatus === "sold" || product.productStatus === "reserved") {
            return ctx.send(
              {
                error: {
                  message: "This product has already been purchased and is no longer available.",
                  code: "PRODUCT_SOLD",
                },
              },
              409,
            );
          }
          return ctx.badRequest("This item is no longer available.");
        }

        const productPrice = acceptedOffer
          ? Number(acceptedOffer.offerPrice)
          : Number(product.price);
        if (!Number.isFinite(productPrice) || productPrice <= 0) {
          return ctx.badRequest("This item has an invalid price.");
        }

        const settings = await strapi.documents("api::marketplace-setting.marketplace-setting").findMany({
          status: "published",
          sort: { createdAt: "desc" },
          limit: 1,
          fields: ["commissionRate"],
        });
        const commissionRate = Number(settings?.[0]?.commissionRate ?? 0);
        const buyerProtectionFee =
          Number.isFinite(commissionRate) && commissionRate >= 0 && commissionRate <= 100
            ? Math.round((productPrice * commissionRate / 100 + Number.EPSILON) * 100) / 100
            : 0;
        const shippingFee = Math.max(0, Number(body.shippingFee) || 0);
        const totalAmount = Math.round((productPrice + buyerProtectionFee + shippingFee + Number.EPSILON) * 100) / 100;
        // 🔍 Check for existing order
        const existingOrder = await strapi.entityService.findMany(
          "api::order.order",
          {
            filters: {
              $and: [
                { buyer: body.buyerId },
                { seller: body.sellerId },
                { product: body.productId },
                {
                  orderStatus: {
                    $notIn: ["cancelled", "delivered"],
                  },
                },
              ],
            },
            limit: 1,
          },
        );

        if (existingOrder.length > 0) {
          return ctx.badRequest(
            "Order already exists for this buyer, seller, and product.",
          );
        }

        // ── Atomic product claim ─────────
        // Two buyers may reach checkout at the same time. Only the request
        // whose conditional UPDATE actually flips the product row from an
        // available state to 'sold' may proceed to create the order; every
        // other concurrent request loses the race and is rejected here,
        // before any order is created or payment is charged.
        const claimedRows = await strapi.db.connection("products")
          .where("id", Number(body.productId))
          .whereIn("product_status", ["active", "reserved"])
          .update({ product_status: "sold", updated_at: new Date() });

        if (!claimedRows) {
          return ctx.send(
            {
              error: {
                message: "This product has already been purchased and is no longer available.",
                code: "PRODUCT_SOLD",
              },
            },
            409,
          );
        }

        try {
          // Create the order using Strapi's entity service
          const newOrder = await strapi.entityService.create("api::order.order", {
            data: {
              product: body.productId || null,
              productTitle: body.productTitle,
              productPrice,
              //   currency: body.currency,
              productImage: body.productImage,
              buyerProtectionFee,
              shippingFee,
              totalAmount,
              seller: Number(body.sellerId) || null,
              buyer: body.buyerId || null,
              phoneNumber: body.phoneNumber || null,
              address: body.address || null,
              deliveryMethod: body.deliveryMethod || null,
              orderStatus: body.OrderStatus,
              paymentStatus: "paid",
            },
          });
          if (acceptedOffer) {
            await strapi.entityService.update("api::offer.offer" as any, acceptedOffer.id, {
              data: { status: "completed", order: newOrder.id },
            });
          }

          // ── Post-purchase invalidation of competing offers ──────────────
          // Only after the purchase is confirmed: every other still-actionable
          // offer (pending or accepted) for this product becomes unavailable.
          try {
            const competingOffers = await strapi.entityService.findMany(
              "api::offer.offer" as any,
              {
                filters: {
                  product: { id: body.productId },
                  status: ["pending", "accepted"],
                  id: acceptedOffer ? { $ne: acceptedOffer.id } : {},
                },
                populate: { buyer: { fields: ["id"] }, conversation: { fields: ["id"] } },
                limit: 100,
              }
            ) as any[];

            if (competingOffers.length > 0) {
              await strapi.db.query("api::offer.offer" as any).updateMany({
                where: {
                  id: { $in: competingOffers.map((o) => o.id) },
                  status: ["pending", "accepted"],
                },
                data: { status: "unavailable" },
              });
            }

            // Notify affected buyers after the purchase is confirmed.
            setImmediate(async () => {
              try {
                for (const other of competingOffers) {
                  const otherBuyerId = other.buyer?.id;
                  if (otherBuyerId) {
                    await strapi.entityService.create('api::notification.notification' as any, {
                      data: {
                        type: 'offer_unavailable',
                        title: 'Offer No Longer Available',
                        body: `"${body.productTitle ?? 'The product'}" has already been purchased and is no longer available.`,
                        read: false,
                        link: `/products/${body.productId}`,
                        recipient: otherBuyerId,
                      },
                    });
                  }
                  const otherConversationId = Number(other.conversation?.id);
                  if (otherConversationId) {
                    (strapi as any).io?.to(`conversation:${otherConversationId}`).emit("offer:invalidated", {
                      offerId: other.id,
                      conversationId: otherConversationId,
                      reason: "This product has already been purchased and is no longer available.",
                    });
                  }
                }
              } catch (e) {
                strapi.log.error('Post-purchase offer invalidation notifications failed:', e);
              }
            });
          } catch (invalidationError) {
            // Invalidation must not fail the confirmed purchase.
            strapi.log.error('Failed to invalidate competing offers:', invalidationError);
          }

        //  const userNotificationSetting = await strapi.config.index.findUserNotificationSettingByUserID(body.buyerId)
        // const isCreateNotification =   userNotificationSetting?.notificationSettings?.newOrder;
          if (newOrder 
            // && isCreateNotification
          ) {
            try {
              await createNotification({
                strapi,
                recipientId: body.sellerId,
                type: "order",
                title: "New Order Received",
                body: `You received an order from ${body.username} on ${body.productTitle}.`,
                link: `/Orders`,
              });
            } catch (notifError) {
              // Log notification failure but don't break the user's favorite saving experience
              strapi.log.error(
                "Failed to send favorite notification:",
                notifError,
              );
            }
          }
          return ctx.created(newOrder);
        } catch (orderError) {
          // The order could not be persisted — release the claim so the
          // product is not left permanently unavailable by a failed purchase.
          await strapi.db.connection("products")
            .where("id", Number(body.productId))
            .where("product_status", "sold")
            .update({ product_status: "active", updated_at: new Date() })
            .catch((releaseError: any) =>
              strapi.log.error('Failed to release product claim after order failure:', releaseError),
            );
          throw orderError;
        }
      } catch (error) {
        console.error("Error placing order:", error); // Debugging line
        return ctx.internalServerError(
          "An error occurred while placing the order.",
        );
      }
    },
    async fetchOrdersByUser(ctx) {
      try {
        const { body } = ctx.request as any; // Type assertion to access body
        console.log("Received order data:", body);
        // Debugging line

        //   if (!userId) {
        //     return ctx.badRequest("Missing required parameter: userId");
        //   }

        const boughtOrders = await strapi.entityService.findMany(
          "api::order.order",
          {
            filters: {
              buyer: { id: Number(body.userId) },
            },
            populate: "*",
          },
        );
        const soldOrders = await strapi.entityService.findMany(
          "api::order.order",
          {
            filters: {
              seller: { id: Number(body.userId) },
            },
            populate: "*",
          },
        );
        const ALLOrders = [];
        boughtOrders?.forEach((order: any) => {
          order.type = "Bought";
          ALLOrders.push(order);
        });
        soldOrders?.forEach((order: any) => {
          order.type = "Sold";
          ALLOrders.push(order);
        });
        return ctx.send({ data: ALLOrders });
      } catch (error) {
        console.error("Error fetching orders:", error);
        return ctx.internalServerError(
          "An error occurred while fetching the orders.",
        );
      }
    },
    async updateStatus(ctx: any) {
      try {
        const { id } = ctx.params;
        const { orderStatus, paymentStatus } = ctx.request.body;

        const data: any = {};
        if (orderStatus !== undefined) data.orderStatus = orderStatus;
        if (paymentStatus !== undefined) data.paymentStatus = paymentStatus;

        // id may be a documentId string — resolve to numeric id first
        const numericId = Number(id);
        let resolvedId: number;
        if (!Number.isNaN(numericId) && numericId > 0) {
          resolvedId = numericId;
        } else {
          const row = await strapi.db.query("api::order.order").findOne({
            where: { documentId: id },
            select: ["id"],
          });
          if (!row) return ctx.notFound("Order not found.");
          resolvedId = row.id;
        }

        const updated = await strapi.entityService.update("api::order.order", resolvedId, { data });
        return ctx.send({ data: updated });
      } catch (error) {
        strapi.log.error(error);
        return ctx.internalServerError("Failed to update order status.");
      }
    },

    async deleteOrder(ctx: any) {
      try {
        const { id } = ctx.params;
        await strapi.entityService.delete("api::order.order", id);
        return ctx.send({ ok: true });
      } catch (error) {
        strapi.log.error(error);
        return ctx.internalServerError("Failed to delete order.");
      }
    },

    async getAllOrders(ctx: any) {
      try {
        const allOrders = await strapi.entityService.findMany(
          "api::order.order",
          {
            populate: {
              buyer: true,
              seller: true,
              product: true,
            },
            sort: { createdAt: "desc" },
          },
        );

        // ✅ Transform data to match frontend UI
        const formattedOrders = allOrders.map((order: any) => ({
          id: order.id,
          documentId: order.documentId,

          buyer: {
            name: order.buyer?.username || "N/A",
            avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=${order.buyer?.username || "user"}`,
          },

          seller: {
            name: order.seller?.username || "N/A",
            avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=${order.seller?.username || "seller"}`,
          },

          amount: order.totalAmount ? `thb${order.totalAmount}` : "thb0.00",

          item: order.product?.title || "Product",
          itemImage: order.product?.image || "https://via.placeholder.com/300",

          role: "User",

          roleColor:
            order.status === "Delivered"
              ? "bg-[#ffede0] text-[#f2994a]"
              : "bg-[#56ab65]",

          status: order.status || "Pending",

          progressStatus:
            order.status === "Delivered"
              ? "Completed"
              : order.status === "Cancelled"
                ? "Cancelled"
                : "In Progress",

          dotColor:
            order.status === "Delivered"
              ? "bg-orange-500"
              : order.status === "Cancelled"
                ? "bg-red-500"
                : "bg-green-600",

          tracking: order.trackingNumber || "N/A",
          carrier: order.carrier || "N/A",
          paymentStatus: order.paymentStatus || "pending",
          orderStatus: order.orderStatus || "placed",
          createdAt: order.createdAt,
        }));

        ctx.body = {
          ok: true,
          data: {
            orders: formattedOrders, // ✅ IMPORTANT: matches frontend
          },
        };
      } catch (error) {
        strapi.log.error(error);
        return ctx.internalServerError("Failed to load orders.");
      }
    },
  }),
);
