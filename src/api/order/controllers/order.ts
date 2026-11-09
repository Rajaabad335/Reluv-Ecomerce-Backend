/**
 * order controller
 */

import { factories } from "@strapi/strapi";
import { createNotification } from "../../../lib/createNotification";
import { stripe } from "../../../utils/stripe";
import {
  fetchStatusGroupPage,
  parseListPagination,
} from "../../../lib/paginatedStatusGroups";

const ORDER_STATUS_GROUPS = [
  { key: "placed", statuses: ["placed"] },
  { key: "in progress", statuses: ["in progress", "shipped"] },
  { key: "delivered", statuses: ["delivered"] },
  { key: "cancelled", statuses: ["cancelled"] },
] as const;

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
        const authenticatedUserId = await getAuthenticatedUserId(strapi, ctx);
        if (!authenticatedUserId) return ctx.unauthorized("Authentication required.");
        if (authenticatedUserId !== Number(body.buyerId)) {
          return ctx.forbidden("You can only place an order for the signed-in buyer.");
        }
        const productId = Number(body.productId);
        if (!Number.isInteger(productId) || productId <= 0) {
          return ctx.badRequest("A valid product is required.");
        }
        const product = await strapi.entityService.findOne(
          "api::product.product",
          productId,
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
              !listingSellerId ||
              ![offerBuyerId, offerSellerId].includes(listingSellerId) ||
              Number(body.sellerId) !== listingSellerId ||
              Number(body.buyerId) !== expectedBuyerId
            ) {
              return ctx.badRequest("The accepted offer participants do not match this order.");
            }
          } else if (matchingOffers.length > 1) {
            return ctx.badRequest("Offer ID is required when more than one accepted offer applies to this product.");
          }
        }

        const productSellerId = Number(product.users_permissions_user?.id ?? product.users_permissions_user);
        if (!productSellerId || Number(body.sellerId) !== productSellerId) {
          return ctx.badRequest("The order seller does not match this product.");
        }

        if (!["active", "reserved"].includes(product.productStatus)) {
          if (product.productStatus === "sold") {
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
        // This endpoint is the current checkout's successful-purchase boundary
        // (it records paymentStatus=paid). Claim only here, after offer
        // acceptance and checkout review. A conditional update ensures that
        // only one concurrent buyer can create the paid order.
        const purchase = await strapi.db.transaction(async ({ trx }: any) => {
          const claimedRows = await trx("products")
            .where("id", productId)
            .whereIn("product_status", ["active", "reserved"])
            .update({ product_status: "sold", updated_at: new Date() });
          if (!claimedRows) return null;

          const order = await strapi.entityService.create("api::order.order", {
            data: {
              product: productId,
              productTitle: body.productTitle,
              productPrice,
              productImage: body.productImage,
              buyerProtectionFee,
              shippingFee,
              totalAmount,
              seller: productSellerId,
              buyer: authenticatedUserId,
              phoneNumber: body.phoneNumber || null,
              address: body.address || null,
              deliveryMethod: body.deliveryMethod || null,
              orderStatus: body.OrderStatus,
              paymentStatus: "paid",
            },
          });

          if (acceptedOffer) {
            await strapi.entityService.update("api::offer.offer" as any, acceptedOffer.id, {
              data: { status: "completed", order: order.id },
            });
          }
          return order;
        });

        if (!purchase) {
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

        const newOrder = purchase;
        try {

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
          // The order and product claim already committed together. A later
          // side-effect failure must not undo the confirmed purchase.
          strapi.log.error("Order was placed, but post-purchase processing failed:", orderError);
          return ctx.created(newOrder);
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
        const { body = {} } = ctx.request as any;
        const userId = Number(body.userId);
        if (!Number.isInteger(userId) || userId <= 0) {
          return ctx.badRequest("A valid userId is required.");
        }

        const requestedType = String(body.type ?? "all").toLowerCase();
        const type = requestedType === "bought" || requestedType === "sold"
          ? requestedType
          : requestedType === "all" ? "all" : null;
        if (!type) return ctx.badRequest("type must be all, Bought, or Sold.");

        const requestedStatus = String(body.status ?? "all").trim().toLowerCase();
        const statusAliases: Record<string, string> = {
          all: "all",
          placed: "placed",
          "in progress": "in progress",
          shipped: "in progress",
          completed: "delivered",
          delivered: "delivered",
          cancelled: "cancelled",
        };
        const statusKey = statusAliases[requestedStatus];
        if (!statusKey) {
          return ctx.badRequest("status must be All, Placed, In Progress, Completed, or Cancelled.");
        }

        const { page: requestedPage, pageSize } = parseListPagination(body.page, body.pageSize);
        const participantFilters: any = type === "bought"
          ? { buyer: { id: userId } }
          : type === "sold"
            ? { seller: { id: userId }, buyer: { id: { $ne: userId } } }
            : { $or: [{ buyer: { id: userId } }, { seller: { id: userId } }] };

        const selectedGroups = statusKey === "all"
          ? ORDER_STATUS_GROUPS
          : ORDER_STATUS_GROUPS.filter((group) => group.key === statusKey);
        const groups = await Promise.all(selectedGroups.map(async (group) => ({
          key: group.key,
          statuses: group.statuses,
          total: await strapi.entityService.count("api::order.order", {
            filters: {
              $and: [participantFilters, { orderStatus: { $in: [...group.statuses] } }],
            },
          }),
        })));

        const [paged, [bought, soldIncludingSelf, selfPurchased]] = await Promise.all([
          fetchStatusGroupPage({
            groups,
            page: requestedPage,
            pageSize,
            fetchGroup: async (_groupKey, start, limit) => strapi.entityService.findMany(
              "api::order.order",
              {
                filters: {
                  $and: [participantFilters, { orderStatus: { $in: [...groups.find((group) => group.key === _groupKey)!.statuses] } }],
                },
                populate: {
                  product: { fields: ["id", "title"] },
                  buyer: { fields: ["id", "username"] },
                  seller: { fields: ["id", "username"] },
                },
                sort: [{ createdAt: "desc" }, { id: "desc" }],
                start,
                limit,
              },
            ),
          }),
          Promise.all([
            strapi.entityService.count("api::order.order", { filters: { buyer: { id: userId } } }),
            strapi.entityService.count("api::order.order", { filters: { seller: { id: userId } } }),
            strapi.entityService.count("api::order.order", {
              filters: { buyer: { id: userId }, seller: { id: userId } },
            }),
          ]),
        ]);
        const data = paged.data.map((order: any) => ({
          ...order,
          type: Number(order.buyer?.id ?? order.buyer) === userId ? "Bought" : "Sold",
        }));

        return ctx.send({
          data,
          meta: {
            pagination: paged.pagination,
            counts: { bought, sold: Math.max(0, soldIncludingSelf - selfPurchased) },
          },
        });
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

        const getProgressStatus = (status: string | undefined) => {
          switch ((status || "").trim().toLowerCase().replace(/_/g, " ")) {
            case "placed":
            case "pending":
              return "Placed";
            case "confirmed":
            case "processing":
            case "in progress":
              return "In Progress";
            case "shipped":
              return "Shipped";
            case "delivered":
            case "completed":
              return "Delivered";
            case "cancelled":
              return "Cancelled";
            default:
              return "N/A";
          }
        };

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

          roleColor: "bg-[#56ab65]",

          status: order.paymentStatus || "pending",

          progressStatus: getProgressStatus(order.orderStatus),

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

    /**
     * GET /orders/:id/payment-summary
     */
    async getPaymentSummary(ctx: any) {
      try {
        const { id } = ctx.params;
        const numericId = Number(id);
        let resolvedId = numericId;
        if (Number.isNaN(numericId) || numericId <= 0) {
          const row = await strapi.db.query("api::order.order").findOne({
            where: { documentId: id },
            select: ["id"],
          });
          if (!row) return ctx.notFound("Order not found.");
          resolvedId = row.id;
        }

        const order = (await strapi.entityService.findOne(
          "api::order.order",
          resolvedId,
          { populate: { buyer: true, seller: true, product: true } }
        )) as any;

        if (!order) return ctx.notFound("Order not found.");

        const totalAmount = Number(order.totalAmount || 0);
        const amountMinor = Math.round(totalAmount * 100);
        const platformCommissionMinor = Math.round(amountMinor * 0.1);
        const sellerEarningsMinor = amountMinor - platformCommissionMinor;
        const stripeFeeMinor = Math.round(amountMinor * 0.0365) + 1000;

        return ctx.send({
          ok: true,
          data: {
            orderId: order.id,
            currency: order.currency || "thb",
            totalAmount,
            amountMinor,
            platformCommission: platformCommissionMinor / 100,
            platformCommissionMinor,
            commissionRate: 10,
            sellerEarnings: sellerEarningsMinor / 100,
            sellerEarningsMinor,
            stripeFee: stripeFeeMinor / 100,
            stripeFeeMinor,
            paymentStatus: order.paymentStatus || "pending",
            payoutStatus: order.payoutStatus || "NOT_ELIGIBLE",
            paymentIntentId: order.paymentIntentId || null,
            chargeId: order.chargeId || null,
            orderStatus: order.orderStatus || "placed",
            deliveredAt: order.deliveredAt || null,
            disputeDeadline: order.disputeDeadline || null,
            payoutEligibleAt: order.payoutEligibleAt || null,
            disputeWindowStatus: order.disputeWindowStatus || "CLOSED",
          },
        });
      } catch (error) {
        strapi.log.error("Error in getPaymentSummary:", error);
        return ctx.internalServerError("Failed to retrieve payment summary.");
      }
    },

    /**
     * POST /orders/:id/confirm-delivery
     */
    async confirmDelivery(ctx: any) {
      try {
        const { id } = ctx.params;
        const numericId = Number(id);
        let resolvedId = numericId;
        if (Number.isNaN(numericId) || numericId <= 0) {
          const row = await strapi.db.query("api::order.order").findOne({
            where: { documentId: id },
            select: ["id"],
          });
          if (!row) return ctx.notFound("Order not found.");
          resolvedId = row.id;
        }

        const order = (await strapi.entityService.findOne(
          "api::order.order",
          resolvedId,
          { populate: { buyer: true, seller: true } }
        )) as any;

        if (!order) return ctx.notFound("Order not found.");

        // Prevent repeated delivery confirmation from resetting the 48-hour timer!
        if (order.deliveredAt && (order.orderStatus || "").toLowerCase() === "delivered") {
          return ctx.send({
            ok: true,
            message: "Delivery was already confirmed. Dispute window remains active without resetting timer.",
            data: order,
          });
        }

        const now = new Date();
        const deliveredAt = now.toISOString();
        const disputeDeadline = new Date(now.getTime() + 48 * 60 * 60 * 1000).toISOString();
        const totalAmount = Number(order.totalAmount || 0);

        const updated = await strapi.entityService.update(
          "api::order.order",
          resolvedId,
          {
            data: {
              orderStatus: "delivered",
              deliveredAt,
              disputeDeadline,
              payoutEligibleAt: disputeDeadline,
              disputeWindowStatus: "OPEN",
              payoutStatus: "NOT_ELIGIBLE",
              platformCommission: Math.round(totalAmount * 0.1 * 100) / 100,
              sellerEarnings: Math.round(totalAmount * 0.9 * 100) / 100,
            } as any,
          }
        );

        if (order.buyer?.id) {
          await createNotification({
            strapi,
            recipientId: order.buyer.id,
            type: "order_update",
            title: "Order Delivered",
            body: `Order #${resolvedId} has been confirmed delivered. Your 48-hour buyer dispute window is now active until ${new Date(
              disputeDeadline
            ).toLocaleTimeString("en-GB")}.`,
            link: "/Orders",
          });
        }

        return ctx.send({
          ok: true,
          message: "Order marked DELIVERED. 48-hour dispute window started.",
          data: updated,
        });
      } catch (error) {
        strapi.log.error("Error confirming delivery:", error);
        return ctx.internalServerError("Failed to confirm delivery.");
      }
    },

    /**
     * GET /orders/:id/dispute-eligibility
     */
    async getDisputeEligibility(ctx: any) {
      try {
        const { id } = ctx.params;
        const numericId = Number(id);
        let resolvedId = numericId;
        if (Number.isNaN(numericId) || numericId <= 0) {
          const row = await strapi.db.query("api::order.order").findOne({
            where: { documentId: id },
            select: ["id"],
          });
          if (!row) return ctx.notFound("Order not found.");
          resolvedId = row.id;
        }

        const order = (await strapi.entityService.findOne(
          "api::order.order",
          resolvedId,
          { populate: { buyer: true, seller: true } }
        )) as any;

        if (!order) return ctx.notFound("Order not found.");

        const isDelivered = (order.orderStatus || "").toLowerCase() === "delivered";
        const deliveredAt = order.deliveredAt;
        const disputeDeadline = order.disputeDeadline
          ? order.disputeDeadline
          : deliveredAt
          ? new Date(new Date(deliveredAt).getTime() + 48 * 60 * 60 * 1000).toISOString()
          : null;

        const isRefunded = (order.paymentStatus || "").toLowerCase() === "refunded";
        const payoutStatus = (order.payoutStatus || "NOT_ELIGIBLE").toUpperCase();
        const isPayoutReleased = ["PAID", "TRANSFERRED"].includes(payoutStatus);

        const now = Date.now();
        const isWithin48h = disputeDeadline ? now <= new Date(disputeDeadline).getTime() : false;

        const disputes = (await strapi.entityService.findMany(
          "api::dispute.dispute",
          { filters: { order: { id: resolvedId } } as any }
        )) as any[];

        const hasActiveDispute = disputes.some((d: any) =>
          ["OPEN", "UNDER_REVIEW", "AWAITING_INFORMATION"].includes((d.status || "").toUpperCase())
        );

        let eligible = false;
        let reason: string | null = null;

        if (!isDelivered) {
          reason = "Order is not yet delivered.";
        } else if (!isWithin48h) {
          reason = "The 48-hour dispute and refund request period has expired.";
        } else if (isRefunded) {
          reason = "The order has already been refunded.";
        } else if (isPayoutReleased) {
          reason = "The seller payout has already been released.";
        } else if (hasActiveDispute) {
          reason = "An active dispute or refund request already exists for this order.";
        } else {
          eligible = true;
        }

        const remainingMs = disputeDeadline
          ? Math.max(0, new Date(disputeDeadline).getTime() - now)
          : 0;
        const remainingHours = Math.floor(remainingMs / (1000 * 60 * 60));
        const remainingMinutes = Math.floor((remainingMs % (1000 * 60 * 60)) / (1000 * 60));

        return ctx.send({
          ok: true,
          data: {
            eligible,
            reason,
            deliveredAt,
            disputeDeadline,
            remainingHours,
            remainingMinutes,
            hasActiveDispute,
            isRefunded,
            payoutStatus,
          },
        });
      } catch (error) {
        strapi.log.error("Error in getDisputeEligibility:", error);
        return ctx.internalServerError("Failed to check dispute eligibility.");
      }
    },

    /**
     * POST /orders/:id/disputes
     */
    async createOrderDispute(ctx: any) {
      try {
        const { id } = ctx.params;
        const { reason, description, evidence, raisedBy, sellerId } =
          ctx.request.body || {};

        const numericId = Number(id);
        let resolvedId = numericId;
        if (Number.isNaN(numericId) || numericId <= 0) {
          const row = await strapi.db.query("api::order.order").findOne({
            where: { documentId: id },
            select: ["id"],
          });
          if (!row) return ctx.notFound("Order not found.");
          resolvedId = row.id;
        }

        const order = (await strapi.entityService.findOne(
          "api::order.order",
          resolvedId,
          { populate: { buyer: true, seller: true } }
        )) as any;

        if (!order) return ctx.notFound("Order not found.");

        const currentPayoutStatus = (order.payoutStatus || "").toUpperCase();
        if (["PROCESSING", "PAID", "TRANSFERRED"].includes(currentPayoutStatus)) {
          return ctx.badRequest(
            "Cannot file dispute: Seller payout is already being processed or completed."
          );
        }

        if ((order.orderStatus || "").toLowerCase() !== "delivered") {
          return ctx.badRequest("Disputes can only be filed after order is delivered.");
        }

        const deadline = order.disputeDeadline
          ? new Date(order.disputeDeadline).getTime()
          : new Date(order.deliveredAt).getTime() + 48 * 60 * 60 * 1000;
        if (Date.now() > deadline) {
          return ctx.badRequest("The 48-hour dispute window has expired.");
        }

        const existingDisputes = (await strapi.entityService.findMany(
          "api::dispute.dispute",
          { filters: { order: { id: resolvedId } } as any }
        )) as any[];

        const activeExists = existingDisputes.some((d: any) =>
          ["OPEN", "UNDER_REVIEW", "AWAITING_INFORMATION"].includes((d.status || "").toUpperCase())
        );
        if (activeExists) {
          return ctx.badRequest("An active dispute already exists for this order.");
        }

        await strapi.entityService.update("api::order.order", resolvedId, {
          data: { payoutStatus: "ON_HOLD" } as any,
        });

        const newDispute = (await strapi.entityService.create(
          "api::dispute.dispute",
          {
            data: {
              order: { id: resolvedId },
              raisedBy: raisedBy || order.buyer?.id,
              recievedBy: sellerId || order.seller?.id,
              requestType: "DISPUTE",
              reason: reason || "OTHER",
              description: description || "",
              evidence: evidence || null,
              status: "OPEN",
              refundAmount: Number(order.totalAmount || 0),
            } as any,
          }
        )) as any;

        const buyerId = raisedBy || order.buyer?.id;
        const targetSellerId = sellerId || order.seller?.id;
        if (buyerId) {
          await createNotification({
            strapi,
            recipientId: buyerId,
            type: "dispute_raised",
            title: "Dispute Submitted",
            body: `Your dispute on Order #${resolvedId} was submitted and seller payout is on hold pending admin review.`,
            link: "/Orders?tab=Disputes_Raised",
          });
        }
        if (targetSellerId) {
          await createNotification({
            strapi,
            recipientId: targetSellerId,
            type: "dispute_received",
            title: "Dispute Received - Payout On Hold",
            body: `A buyer dispute (${reason}) was filed on Order #${resolvedId}. Payout has been placed on hold.`,
            link: "/Orders?tab=Disputes_Recieved",
          });
        }

        return ctx.created({
          ok: true,
          message: "Dispute filed successfully. Seller payout placed on hold.",
          data: newDispute,
        });
      } catch (error) {
        strapi.log.error("Error creating dispute:", error);
        return ctx.internalServerError("Failed to submit dispute.");
      }
    },

    /**
     * POST /orders/:id/refund-requests
     */
    async createRefundRequest(ctx: any) {
      try {
        const { id } = ctx.params;
        const { reason, description, evidence, refundAmount, raisedBy, sellerId } =
          ctx.request.body || {};

        const numericId = Number(id);
        let resolvedId = numericId;
        if (Number.isNaN(numericId) || numericId <= 0) {
          const row = await strapi.db.query("api::order.order").findOne({
            where: { documentId: id },
            select: ["id"],
          });
          if (!row) return ctx.notFound("Order not found.");
          resolvedId = row.id;
        }

        const order = (await strapi.entityService.findOne(
          "api::order.order",
          resolvedId,
          { populate: { buyer: true, seller: true } }
        )) as any;

        if (!order) return ctx.notFound("Order not found.");

        const currentPayoutStatus = (order.payoutStatus || "").toUpperCase();
        if (["PROCESSING", "PAID", "TRANSFERRED"].includes(currentPayoutStatus)) {
          return ctx.badRequest(
            "Cannot request refund: Seller payout is already being processed or completed."
          );
        }

        if ((order.orderStatus || "").toLowerCase() !== "delivered") {
          return ctx.badRequest("Refund requests can only be submitted after order is delivered.");
        }

        const deadline = order.disputeDeadline
          ? new Date(order.disputeDeadline).getTime()
          : new Date(order.deliveredAt).getTime() + 48 * 60 * 60 * 1000;
        if (Date.now() > deadline) {
          return ctx.badRequest("The 48-hour dispute and refund window has expired.");
        }

        await strapi.entityService.update("api::order.order", resolvedId, {
          data: { payoutStatus: "ON_HOLD" } as any,
        });

        const effectiveRefundAmount =
          refundAmount !== undefined ? Number(refundAmount) : Number(order.totalAmount || 0);

        const newRequest = (await strapi.entityService.create(
          "api::dispute.dispute",
          {
            data: {
              order: { id: resolvedId },
              raisedBy: raisedBy || order.buyer?.id,
              recievedBy: sellerId || order.seller?.id,
              requestType: "REFUND_REQUEST",
              reason: reason || "OTHER",
              description: description || "",
              evidence: evidence || null,
              status: "OPEN",
              refundStatus: "PENDING",
              refundAmount: effectiveRefundAmount,
            } as any,
          }
        )) as any;

        const buyerId = raisedBy || order.buyer?.id;
        const targetSellerId = sellerId || order.seller?.id;
        if (buyerId) {
          await createNotification({
            strapi,
            recipientId: buyerId,
            type: "dispute_raised",
            title: "Refund Request Submitted",
            body: `Your refund request of ${effectiveRefundAmount} THB for Order #${resolvedId} is awaiting admin review.`,
            link: "/Orders?tab=Disputes_Raised",
          });
        }
        if (targetSellerId) {
          await createNotification({
            strapi,
            recipientId: targetSellerId,
            type: "dispute_received",
            title: "Refund Request Received - Payout On Hold",
            body: `A refund request was submitted for Order #${resolvedId}. Payout has been placed on hold pending admin review.`,
            link: "/Orders?tab=Disputes_Recieved",
          });
        }

        return ctx.created({
          ok: true,
          message: "Refund request submitted and awaiting admin review. Payout placed on hold.",
          data: newRequest,
        });
      } catch (error) {
        strapi.log.error("Error creating refund request:", error);
        return ctx.internalServerError("Failed to submit refund request.");
      }
    },

    /**
     * GET /orders/:id/disputes
     */
    async getOrderDisputes(ctx: any) {
      try {
        const { id } = ctx.params;
        const numericId = Number(id);
        let resolvedId = numericId;
        if (Number.isNaN(numericId) || numericId <= 0) {
          const row = await strapi.db.query("api::order.order").findOne({
            where: { documentId: id },
            select: ["id"],
          });
          if (!row) return ctx.notFound("Order not found.");
          resolvedId = row.id;
        }

        const disputes = await strapi.entityService.findMany(
          "api::dispute.dispute",
          {
            filters: { order: { id: resolvedId } } as any,
            populate: { raisedBy: true, recievedBy: true, order: true },
            sort: { createdAt: "desc" },
          }
        );

        return ctx.send({ ok: true, data: disputes });
      } catch (error) {
        strapi.log.error("Error getting order disputes:", error);
        return ctx.internalServerError("Failed to get order disputes.");
      }
    },
  }),
);
