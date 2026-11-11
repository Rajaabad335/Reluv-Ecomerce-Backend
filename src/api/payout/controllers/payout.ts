/**
 * Payout & Financial Management Controller
 * Fully implements complete marketplace payment, dispute, refund, and seller payout management.
 */

import { factories } from "@strapi/strapi";
import { createNotification } from "../../../lib/createNotification";
import { stripe } from "../../../utils/stripe";

// Processed Webhook Event ID cache for deduplication
const processedWebhookEventIds = new Set<string>();

/**
 * Stripe Connect Payout Provider Service
 * Executes seller transfers through Stripe Connect.
 */
export const stripeConnectPayoutService = {
  async executePayout({
    orderId,
    sellerId,
    amountMinor,
    currency = "thb",
    destinationAccountId,
  }: {
    orderId: number;
    sellerId: number;
    amountMinor: number;
    currency?: string;
    destinationAccountId?: string;
  }) {
    if (!destinationAccountId) {
      return {
        isMock: false,
        status: "FAILED",
        error: "Seller does not have a Stripe Connect account configured.",
      };
    }

    try {
      const transfer = await stripe.transfers.create({
        amount: amountMinor,
        currency: currency.toLowerCase(),
        destination: destinationAccountId,
        metadata: {
          orderId: String(orderId),
          sellerId: String(sellerId),
        },
      });

      return {
        isMock: false,
        status: "TRANSFERRED",
        transferId: transfer.id,
        payoutId: null,
        provider: "STRIPE_CONNECT",
        message:
          "Real Stripe Connect transfer executed to seller connected account.",
      };
    } catch (err: unknown) {
      return {
        isMock: false,
        status: "FAILED",
        error:
          err instanceof Error ? err.message : "Stripe Connect transfer failed",
      };
    }
  },
};

const FINALIZED_DISPUTE_STATUSES = [
  "RESOLVED_REFUND",
  "RESOLVED_RELEASE",
  "RESOLVED",
  "REJECTED",
  "CLOSED",
];

async function getAuthenticatedUserId(strapi: any, ctx: any): Promise<number | null> {
  const stateId = Number(ctx?.state?.user?.id);
  if (Number.isInteger(stateId) && stateId > 0) return stateId;
  const authorization = String(ctx?.request?.headers?.authorization ?? "");
  if (!authorization.startsWith("Bearer ")) return null;
  try {
    const payload = await strapi
      .plugin("users-permissions")
      .service("jwt")
      .verify(authorization.slice(7).trim());
    const id = Number(payload?.id);
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

function computeRestoredPayoutStatus(order: any): string {
  if (!order) return "NOT_ELIGIBLE";
  if ((order.paymentStatus || "").toLowerCase() === "refunded") {
    return "CANCELLED";
  }
  const current = (order.payoutStatus || "").toUpperCase();
  if (["PAID", "TRANSFERRED"].includes(current)) {
    return current;
  }
  const isDelivered = (order.orderStatus || "").toLowerCase() === "delivered";
  const deliveredAt = order.deliveredAt || order.updatedAt || order.createdAt;
  const deadline = order.disputeDeadline
    ? new Date(order.disputeDeadline).getTime()
    : deliveredAt
    ? new Date(deliveredAt).getTime() + 48 * 60 * 60 * 1000
    : null;
  if (isDelivered && deadline && Date.now() >= deadline) {
    return "ELIGIBLE";
  }
  return "NOT_ELIGIBLE";
}

async function findDisputeWithRelations(strapi: any, disputeId: number | string) {
  const populate = {
    order: { populate: { buyer: true, seller: true, product: true } },
    raisedBy: true,
    recievedBy: true,
  };
  if (typeof disputeId === "number" || !isNaN(Number(disputeId))) {
    return (await strapi.entityService.findOne(
      "api::dispute.dispute",
      Number(disputeId),
      { populate }
    )) as any;
  }
  const rows = (await strapi.entityService.findMany("api::dispute.dispute", {
    filters: { documentId: disputeId } as any,
    populate,
  })) as any[];
  return rows?.[0] || null;
}

interface ExecuteSellerPayoutResult {
  ok: boolean;
  statusCode: number;
  message: string;
  payout?: any;
  order?: any;
  sellerAmount?: number;
  commissionAmount?: number;
  transferId?: string;
  destinationAccountId?: string;
}

async function executeSellerPayoutForOrder(
  strapi: any,
  {
    orderId,
    notes,
    fallbackOrderPayoutStatus = "FAILED",
  }: {
    orderId: number;
    notes?: string | null;
    fallbackOrderPayoutStatus?: string;
  }
): Promise<ExecuteSellerPayoutResult> {
  const order = (await strapi.entityService.findOne(
    "api::order.order",
    Number(orderId),
    { populate: { buyer: true, seller: true } }
  )) as any;

  if (!order) {
    return { ok: false, statusCode: 404, message: "Order not found." };
  }

  if ((order.paymentStatus || "").toLowerCase() === "refunded") {
    return {
      ok: false,
      statusCode: 400,
      message: "Cannot release payout: This order has been refunded.",
    };
  }

  const existingPayouts = (await strapi.entityService.findMany(
    "api::payout.payout",
    { filters: { order: { id: order.id } } as any }
  )) as any[];

  const alreadyPaid = existingPayouts.some(
    (p: any) =>
      p.isMock !== true &&
      ["success", "paid", "processing", "transferred"].includes(
        (p.status || "").toLowerCase()
      )
  );
  if (
    alreadyPaid ||
    ["PAID", "TRANSFERRED", "PROCESSING"].includes(
      (order.payoutStatus || "").toUpperCase()
    )
  ) {
    return {
      ok: false,
      statusCode: 400,
      message:
        "Cannot release payout: Payout has already been processed or completed.",
    };
  }

  const destinationAccountId = order.seller?.stripeAccountId;
  if (!destinationAccountId) {
    return {
      ok: false,
      statusCode: 400,
      message:
        "Seller does not have a connected Stripe Connect account yet. Ask the seller to connect Stripe in Settings -> Payments before releasing payout.",
    };
  }

  const totalAmt = Number(order.totalAmount || 0);
  const commissionAmount = Math.round(totalAmt * 0.1 * 100) / 100;
  const sellerAmount = Math.round(totalAmt * 0.9 * 100) / 100;

  if (!Number.isFinite(sellerAmount) || sellerAmount <= 0) {
    return {
      ok: false,
      statusCode: 400,
      message: "Cannot release payout: Seller payout amount must be greater than zero.",
    };
  }

  await strapi.entityService.update("api::order.order", order.id, {
    data: { payoutStatus: "PROCESSING" } as any,
  });

  const payoutResult = await stripeConnectPayoutService.executePayout({
    orderId: order.id,
    sellerId: order.seller?.id,
    amountMinor: Math.round(sellerAmount * 100),
    currency: order.currency || "thb",
    destinationAccountId,
  });

  const payout = (await strapi.entityService.create("api::payout.payout", {
    data: {
      seller: order.seller?.id,
      order: order.id,
      grossAmount: totalAmt,
      commissionRate: 10,
      commissionAmount,
      netAmount: sellerAmount,
      currency: String(order.currency || "thb").toLowerCase().slice(0, 3),
      status: payoutResult.status === "FAILED" ? "failed" : "success",
      isMock: false,
      stripeAccountId: destinationAccountId,
      stripeTransferId: payoutResult.transferId,
      stripePayoutId: payoutResult.payoutId,
      bankAccountLast4: order.seller?.bankAccountLast4 || null,
      processedAt: new Date(),
      notes: notes || null,
      failureReason: payoutResult.error || null,
    } as any,
  })) as any;

  await strapi.entityService.update("api::order.order", order.id, {
    data: {
      payoutStatus:
        payoutResult.status === "FAILED" ? fallbackOrderPayoutStatus : "PAID",
      platformCommission: commissionAmount,
      sellerEarnings: sellerAmount,
    } as any,
  });

  if (payoutResult.status === "FAILED" || !payoutResult.transferId) {
    return {
      ok: false,
      statusCode: 400,
      message:
        payoutResult.error || "Stripe Connect transfer could not be completed.",
    };
  }

  return {
    ok: true,
    statusCode: 200,
    message: "Stripe Connect transfer created successfully.",
    payout,
    order,
    sellerAmount,
    commissionAmount,
    transferId: payoutResult.transferId,
    destinationAccountId,
  };
}

function getStripeRefundTarget(order: any): {
  payment_intent?: string;
  charge?: string;
} | null {
  if (order?.paymentIntentId) {
    return { payment_intent: order.paymentIntentId };
  }
  if (order?.chargeId) {
    return { charge: order.chargeId };
  }
  return null;
}

export default factories.createCoreController(
  "api::payout.payout",
  ({ strapi }) => ({
    /**
     * 1. GET /api/admin/financial-summary
     */
    async getFinancialSummary(ctx) {
      try {
        const orders = (await strapi.entityService.findMany(
          "api::order.order",
          {
            populate: { buyer: true, seller: true },
          }
        )) as any[];

        const disputes = (await strapi.entityService.findMany(
          "api::dispute.dispute",
          {
            populate: { order: true, raisedBy: true, recievedBy: true },
          }
        )) as any[];

        const payouts = (await strapi.entityService.findMany(
          "api::payout.payout",
          {
            populate: { order: true, seller: true },
          }
        )) as any[];

        const commissionRate = 0.1; // 10%

        let totalPaymentsReceived = 0;
        let pendingPayouts = 0;
        let eligiblePayouts = 0;
        let payoutsOnHold = 0;
        let completedPayouts = 0;

        const activeDisputesByOrder = new Map<number, any>();
        let openDisputesCount = 0;
        let pendingRefundsCount = 0;

        for (const disp of disputes) {
          const s = (disp.status || "OPEN").toUpperCase();
          if (["OPEN", "UNDER_REVIEW", "AWAITING_INFORMATION"].includes(s)) {
            openDisputesCount++;
            if (disp.order?.id) {
              activeDisputesByOrder.set(Number(disp.order.id), disp);
            }
          }
          if (
            disp.refundAmount ||
            disp.requestType === "REFUND_REQUEST" ||
            ["ITEM_NOT_RECEIVED", "DAMAGED_PRODUCT", "WRONG_ITEM"].includes(
              disp.reason
            )
          ) {
            if (
              s !== "RESOLVED_REFUND" &&
              s !== "CLOSED" &&
              s !== "RESOLVED_RELEASE"
            ) {
              pendingRefundsCount++;
            }
          }
        }

        const completedPayoutsByOrder = new Map<number, any>();
        for (const po of payouts) {
          const st = (po.status || "").toLowerCase();
          if (
            po.isMock !== true &&
            (po.stripeTransferId || po.stripePayoutId) &&
            (st === "success" || st === "paid" || st === "transferred")
          ) {
            completedPayouts += Number(po.netAmount || 0);
            if (po.order?.id) {
              completedPayoutsByOrder.set(Number(po.order.id), po);
            }
          }
        }

        const now = Date.now();

        for (const o of orders) {
          const totalAmt = Number(o.totalAmount || 0);
          const isPaid = (o.paymentStatus || "").toLowerCase() === "paid";
          const isDelivered =
            (o.orderStatus || "").toLowerCase() === "delivered";
          const isRefunded =
            (o.paymentStatus || "").toLowerCase() === "refunded";

          if (isPaid && !isRefunded) {
            totalPaymentsReceived += totalAmt;

            const sellerEarnings = totalAmt * (1 - commissionRate);
            const hasCompletedPayout = completedPayoutsByOrder.has(Number(o.id));

            if (!hasCompletedPayout) {
              const activeDispute = activeDisputesByOrder.get(Number(o.id));
              if (activeDispute) {
                payoutsOnHold += sellerEarnings;
              } else if (isDelivered) {
                const deliveryTime = new Date(
                  o.deliveredAt || o.updatedAt || o.createdAt
                ).getTime();
                const releaseTime = deliveryTime + 48 * 60 * 60 * 1000;
                if (now >= releaseTime) {
                  eligiblePayouts += sellerEarnings;
                } else {
                  pendingPayouts += sellerEarnings;
                }
              } else {
                pendingPayouts += sellerEarnings;
              }
            }
          }
        }

        const totalPlatformCommission = totalPaymentsReceived * commissionRate;
        const totalSellerEarnings = totalPaymentsReceived * (1 - commissionRate);

        return ctx.send({
          ok: true,
          data: {
            totalPaymentsReceived:
              Math.round(totalPaymentsReceived * 100) / 100,
            totalPlatformCommission:
              Math.round(totalPlatformCommission * 100) / 100,
            totalSellerEarnings: Math.round(totalSellerEarnings * 100) / 100,
            pendingPayouts: Math.round(pendingPayouts * 100) / 100,
            eligiblePayouts: Math.round(eligiblePayouts * 100) / 100,
            payoutsOnHold: Math.round(payoutsOnHold * 100) / 100,
            completedPayouts: Math.round(completedPayouts * 100) / 100,
            openDisputes: openDisputesCount,
            pendingRefunds: pendingRefundsCount,
            currency: "THB",
          },
        });
      } catch (error) {
        strapi.log.error("Error in getFinancialSummary:", error);
        return ctx.internalServerError("Failed to calculate financial summary.");
      }
    },

    /**
     * 2. GET /api/admin/payout-orders
     */
    async getPayoutOrders(ctx) {
      try {
        const orders = (await strapi.entityService.findMany(
          "api::order.order",
          {
            populate: { buyer: true, seller: true, product: true },
            sort: { createdAt: "desc" },
          }
        )) as any[];

        const disputes = (await strapi.entityService.findMany(
          "api::dispute.dispute",
          {
            populate: { order: true, raisedBy: true, recievedBy: true },
            sort: { createdAt: "desc" },
          }
        )) as any[];

        const payouts = (await strapi.entityService.findMany(
          "api::payout.payout",
          {
            populate: { order: true, seller: true },
            sort: { createdAt: "desc" },
          }
        )) as any[];

        const disputesByOrderId = new Map<number, any>();
        for (const disp of disputes) {
          if (disp.order?.id && !disputesByOrderId.has(Number(disp.order.id))) {
            disputesByOrderId.set(Number(disp.order.id), disp);
          }
        }

        const payoutsByOrderId = new Map<number, any>();
        for (const po of payouts) {
          if (po.isMock === true || !po.order?.id) continue;
          const orderId = Number(po.order.id);
          const existing = payoutsByOrderId.get(orderId);
          const isCompleted = (payout: any) =>
            ["success", "paid"].includes((payout.status || "").toLowerCase()) &&
            Boolean(payout.stripeTransferId || payout.stripePayoutId);
          if (!existing || (isCompleted(po) && !isCompleted(existing))) {
            payoutsByOrderId.set(orderId, po);
          }
        }

        const now = Date.now();
        const commissionRate = 10; // 10%

        const enriched = orders.map((o: any) => {
          const totalAmt = Number(o.totalAmount || 0);
          const commissionAmount = Math.round(totalAmt * 0.1 * 100) / 100;
          const sellerAmount = Math.round(totalAmt * 0.9 * 100) / 100;

          const isDelivered =
            (o.orderStatus || "").toLowerCase() === "delivered";
          const isPaid = (o.paymentStatus || "").toLowerCase() === "paid";
          const isRefunded =
            (o.paymentStatus || "").toLowerCase() === "refunded";

          const deliveredAt = isDelivered
            ? o.deliveredAt || o.updatedAt || o.createdAt
            : null;

          const releaseDate = deliveredAt
            ? new Date(
                new Date(deliveredAt).getTime() + 48 * 60 * 60 * 1000
              ).toISOString()
            : null;

          const is48hExpired = releaseDate
            ? now >= new Date(releaseDate).getTime()
            : false;

          const dispute = disputesByOrderId.get(Number(o.id)) || null;
          const dispStatus = dispute
            ? (dispute.status || "OPEN").toUpperCase()
            : "NONE";
          const hasActiveDispute = [
            "OPEN",
            "UNDER_REVIEW",
            "AWAITING_INFORMATION",
          ].includes(dispStatus);

          const payout = payoutsByOrderId.get(Number(o.id)) || null;
          const payoutDbStatus = (payout?.status || "").toLowerCase();

          let payoutStatus = "Not eligible";
          if (isRefunded || dispStatus === "RESOLVED_REFUND") {
            payoutStatus = "Failed";
          } else if (
            payout &&
            payout.isMock !== true &&
            ["success", "paid"].includes(payoutDbStatus) &&
            (payout.stripeTransferId || payout.stripePayoutId)
          ) {
            payoutStatus = "Paid";
          } else if (payoutDbStatus === "processing") {
            payoutStatus = "Processing";
          } else if (payoutDbStatus === "transferred") {
            payoutStatus = "Transferred";
          } else if (payoutDbStatus === "bank_payout_pending") {
            payoutStatus = "Bank payout pending";
          } else if (payout && payout.isMock === true) {
            payoutStatus = "Failed";
          } else if (["failed", "refused"].includes(payoutDbStatus)) {
            payoutStatus = "Failed";
          } else if (hasActiveDispute) {
            payoutStatus = "On hold";
          } else if (isDelivered && is48hExpired && isPaid && !payout) {
            payoutStatus = "Eligible";
          } else {
            payoutStatus = "Not eligible";
          }

          const canRelease =
            isDelivered &&
            is48hExpired &&
            isPaid &&
            !hasActiveDispute &&
            !isRefunded &&
            ["Eligible", "Failed"].includes(payoutStatus) &&
            Boolean(o.seller?.stripeAccountId);

          return {
            id: Number(o.id),
            orderId: Number(o.id),
            orderRef: `ORD-${String(o.id).padStart(5, "0")}`,
            seller: {
              id: o.seller?.id || 0,
              name: o.seller?.username || "Unknown Seller",
              email: o.seller?.email || "",
              bankName: o.seller?.bankName || "Not provided",
              bankAccountLast4: o.seller?.bankAccountLast4 || "",
              stripeConnectStatus: o.seller?.stripeAccountId ? "Connected" : "Not connected",
            },
            buyer: {
              id: o.buyer?.id || 0,
              name: o.buyer?.username || "Unknown Buyer",
              email: o.buyer?.email || "",
            },
            productTitle: o.productTitle || o.product?.title || "Product Item",
            orderAmount: totalAmt,
            commissionRate,
            commissionAmount,
            sellerAmount,
            orderStatus: o.orderStatus || "placed",
            paymentStatus: o.paymentStatus || "pending",
            deliveredAt,
            releaseDate,
            is48hExpired,
            disputeStatus: dispStatus,
            hasActiveDispute,
            payoutStatus,
            canRelease,
            payoutId: payout?.id || null,
            payoutNotes: payout?.notes || null,
            createdAt: o.createdAt,
          };
        });

        return ctx.send({ ok: true, data: enriched });
      } catch (error) {
        strapi.log.error("Error in getPayoutOrders:", error);
        return ctx.internalServerError("Failed to load payout orders.");
      }
    },

    /**
     * 3. POST /api/admin/release-payout
     */
    async releasePayout(ctx) {
      try {
        const { orderId, notes } = ctx.request.body;
        if (!orderId) {
          return ctx.badRequest("Order ID is required.");
        }

        const order = (await strapi.entityService.findOne(
          "api::order.order",
          Number(orderId),
          { populate: { seller: true, buyer: true } }
        )) as any;

        if (!order) {
          return ctx.notFound("Order not found.");
        }

        if ((order.orderStatus || "").toLowerCase() !== "delivered") {
          return ctx.badRequest(
            "Cannot release payout: Order is not yet delivered."
          );
        }

        const deliveredAt =
          order.deliveredAt || order.updatedAt || order.createdAt;
        const releaseTime =
          new Date(deliveredAt).getTime() + 48 * 60 * 60 * 1000;
        if (Date.now() < releaseTime) {
          return ctx.badRequest(
            "Cannot release payout: The 48-hour dispute window has not expired."
          );
        }

        const disputes = (await strapi.entityService.findMany(
          "api::dispute.dispute",
          {
            filters: { order: { id: orderId } } as any,
          }
        )) as any[];

        const hasActiveDispute = disputes.some((d: any) =>
          ["OPEN", "UNDER_REVIEW", "AWAITING_INFORMATION"].includes(
            (d.status || "").toUpperCase()
          )
        );

        if (hasActiveDispute) {
          return ctx.badRequest(
            "Cannot release payout: An active dispute is currently on hold for this order."
          );
        }

        const transferResult = await executeSellerPayoutForOrder(strapi, {
          orderId: order.id,
          notes: notes || null,
          fallbackOrderPayoutStatus: "FAILED",
        });

        if (!transferResult.ok) {
          return ctx.send(
            {
              error: {
                status: transferResult.statusCode,
                name: "BadRequestError",
                message: transferResult.message,
              },
              ok: false,
              message: transferResult.message,
            },
            transferResult.statusCode
          );
        }

        const { payout, sellerAmount, commissionAmount, transferId } =
          transferResult;

        if (order.seller?.id) {
          await createNotification({
            strapi,
            recipientId: order.seller.id,
            type: "order_update",
            title: "Seller Payout Released",
            body: `Payout of ${sellerAmount.toLocaleString()} THB for Order #ORD-${order.id} has been released to your Stripe Connect account (Transfer: ${transferId}).`,
            link: "/Orders",
          });
        }

        return ctx.send({
          ok: true,
          message: "Stripe Connect transfer created successfully.",
          payout: {
            id: payout.id,
            orderId: order.id,
            sellerAmount,
            commissionAmount,
            transferId,
            payoutId: payout.stripePayoutId || null,
            processedAt: new Date().toISOString(),
            status: "Paid",
          },
        });
      } catch (error) {
        strapi.log.error("Error releasing payout:", error);
        return ctx.internalServerError("Failed to release payout.");
      }
    },

    /**
     * 4. POST /api/admin/dispute-action
     */
    async handleDisputeAction(ctx) {
      try {
        const { disputeId, action, resolution, adminNotes, refundAmount } =
          ctx.request.body || {};

        if (!disputeId || !action) {
          return ctx.badRequest("disputeId and action are required.");
        }

        const dispute = await findDisputeWithRelations(strapi, disputeId);
        if (!dispute) {
          return ctx.notFound("Dispute not found.");
        }

        const order = dispute.order;
        const currentStatus = (dispute.status || "OPEN").toUpperCase();
        const normalizedAction = String(action).trim().toUpperCase();

        if (
          FINALIZED_DISPUTE_STATUSES.includes(currentStatus) &&
          normalizedAction !== "ADD_NOTE"
        ) {
          return ctx.badRequest(
            `This dispute is already finalized (${currentStatus}) and cannot run ${normalizedAction}.`
          );
        }

        if (normalizedAction === "UNDER_REVIEW" || normalizedAction === "ADD_NOTE") {
          const noteText = String(adminNotes ?? resolution ?? "").trim();
          const nextNotes = noteText
            ? dispute.adminNotes && dispute.adminNotes !== noteText
              ? `${dispute.adminNotes}\n${noteText}`
              : noteText
            : dispute.adminNotes || "Admin started reviewing this dispute.";

          const nextStatus = FINALIZED_DISPUTE_STATUSES.includes(currentStatus)
            ? currentStatus
            : "UNDER_REVIEW";

          const updatedDispute = await strapi.entityService.update(
            "api::dispute.dispute",
            dispute.id,
            {
              data: {
                status: nextStatus,
                adminNotes: nextNotes,
              } as any,
            }
          );

          if (!FINALIZED_DISPUTE_STATUSES.includes(nextStatus) && order?.id) {
            await strapi.entityService.update("api::order.order", order.id, {
              data: { payoutStatus: "ON_HOLD" } as any,
            });
          }

          if (dispute.raisedBy?.id) {
            await createNotification({
              strapi,
              recipientId: dispute.raisedBy.id,
              type: "dispute_status_updated",
              title: "Dispute Under Review",
              body: `Your dispute on Order #ORD-${order?.id ?? dispute.id} is now Under Review.${noteText ? ` Note: ${noteText}` : ""}`,
              link: "/Orders?tab=Disputes_Raised",
            });
          }
          if (dispute.recievedBy?.id) {
            await createNotification({
              strapi,
              recipientId: dispute.recievedBy.id,
              type: "dispute_status_updated",
              title: "Dispute Under Admin Review",
              body: `Dispute on Order #ORD-${order?.id ?? dispute.id} is now Under Review by admin.`,
              link: "/Orders?tab=Disputes_Recieved",
            });
          }

          return ctx.send({
            ok: true,
            action: normalizedAction,
            status: nextStatus,
            message:
              nextStatus === "UNDER_REVIEW"
                ? "Dispute moved to Under Review and admin notes saved."
                : "Admin notes saved.",
            data: updatedDispute,
          });
        } else if (normalizedAction === "REFUND_BUYER") {
          const effectiveRefundAmt =
            refundAmount !== undefined && refundAmount !== ""
              ? Number(refundAmount)
              : Number(dispute.refundAmount || order?.totalAmount || 0);

          const refundTarget = getStripeRefundTarget(order);
          if (!refundTarget) {
            return ctx.badRequest(
              "Cannot issue refund: this order has no Stripe payment intent or charge."
            );
          }
          if (!Number.isFinite(effectiveRefundAmt) || effectiveRefundAmt <= 0) {
            return ctx.badRequest("Refund amount must be greater than zero.");
          }
          if (dispute.stripeRefundId && dispute.refundStatus !== "FAILED") {
            return ctx.badRequest(
              "A Stripe refund has already been created for this dispute."
            );
          }
          if ((order?.paymentStatus || "").toLowerCase() === "refunded") {
            return ctx.badRequest("This order has already been refunded.");
          }

          let refund: any;
          try {
            refund = await stripe.refunds.create({
              ...refundTarget,
              amount: Math.round(effectiveRefundAmt * 100),
              metadata: {
                disputeId: String(dispute.id),
                orderId: String(order?.id || ""),
              },
            });
          } catch (stripeErr: any) {
            const msg =
              stripeErr?.message || "Stripe refund request failed.";
            return ctx.badRequest(`Stripe Refund failed: ${msg}`);
          }

          const refundStatus =
            refund.status === "succeeded"
              ? "SUCCEEDED"
              : refund.status === "pending"
              ? "PROCESSING"
              : "FAILED";
          const resolved = refund.status === "succeeded";
          const nextStatus = resolved ? "RESOLVED_REFUND" : "UNDER_REVIEW";

          const updatedDispute = await strapi.entityService.update(
            "api::dispute.dispute",
            dispute.id,
            {
              data: {
                status: nextStatus,
                refundStatus,
                resolvedAt: resolved ? new Date() : null,
                adminDecision: "REFUND_BUYER",
                stripeRefundId: refund.id,
                resolution:
                  resolution ||
                  `Refund of ${effectiveRefundAmt} THB submitted to Stripe (${refund.id}).`,
                adminNotes: adminNotes ?? dispute.adminNotes ?? null,
                refundAmount: effectiveRefundAmt,
              } as any,
            }
          );

          if (order?.id) {
            await strapi.entityService.update("api::order.order", order.id, {
              data: {
                ...(resolved ? { paymentStatus: "refunded" } : {}),
                payoutStatus: resolved ? "CANCELLED" : "ON_HOLD",
              } as any,
            });

            if (resolved) {
              const pos = (await strapi.entityService.findMany(
                "api::payout.payout",
                { filters: { order: { id: order.id } } as any }
              )) as any[];
              for (const p of pos) {
                if (["pending", "processing"].includes(p.status)) {
                  await strapi.entityService.update("api::payout.payout", p.id, {
                    data: {
                      status: "refused",
                      notes: "Order refunded to buyer",
                    } as any,
                  });
                }
              }
            }
          }

          if (resolved && dispute.raisedBy?.id) {
            await createNotification({
              strapi,
              recipientId: dispute.raisedBy.id,
              type: "refund_processed",
              title: "Refund Approved & Processed",
              body: `Your refund of ${effectiveRefundAmt.toLocaleString()} THB for Order #ORD-${
                order?.id ?? dispute.id
              } has been refunded via Stripe (${refund.id}).`,
              link: "/Orders?tab=Disputes_Raised",
            });
          }
          if (resolved && dispute.recievedBy?.id) {
            await createNotification({
              strapi,
              recipientId: dispute.recievedBy.id,
              type: "dispute_resolved",
              title: "Dispute Resolved (Buyer Refunded)",
              body: `Dispute on Order #ORD-${
                order?.id ?? dispute.id
              } was resolved with a buyer refund. Seller payout has been cancelled.`,
              link: "/Orders?tab=Disputes_Recieved",
            });
          }

          return ctx.send({
            ok: true,
            action: "REFUND_BUYER",
            refundId: refund.id,
            refundStatus,
            message: resolved
              ? `Stripe refund of ${effectiveRefundAmt} THB succeeded (${refund.id}). Seller payout cancelled.`
              : `Stripe refund is ${refund.status} (${refund.id}); dispute remains Under Review.`,
            status: nextStatus,
            data: updatedDispute,
          });
        } else if (normalizedAction === "RELEASE_TO_SELLER") {
          if (!resolution || !String(resolution).trim()) {
            return ctx.badRequest(
              "An admin resolution note is required when releasing payout to seller."
            );
          }
          if (!order?.id) {
            return ctx.badRequest("No linked order found for this dispute.");
          }

          const transferResult = await executeSellerPayoutForOrder(strapi, {
            orderId: order.id,
            notes: `Dispute #${dispute.id} resolved in seller favor: ${String(resolution).trim()}`,
            fallbackOrderPayoutStatus: "ON_HOLD",
          });

          if (!transferResult.ok) {
            return ctx.badRequest(transferResult.message);
          }

          const { payout, sellerAmount, transferId, destinationAccountId } =
            transferResult;

          const updatedDispute = await strapi.entityService.update(
            "api::dispute.dispute",
            dispute.id,
            {
              data: {
                status: "RESOLVED_RELEASE",
                resolvedAt: new Date(),
                adminDecision: "RELEASE_TO_SELLER",
                resolution: String(resolution).trim(),
                adminNotes: adminNotes ?? dispute.adminNotes ?? null,
              } as any,
            }
          );

          if (dispute.raisedBy?.id) {
            await createNotification({
              strapi,
              recipientId: dispute.raisedBy.id,
              type: "dispute_resolved",
              title: "Dispute Resolved (Released to Seller)",
              body: `Your dispute for Order #ORD-${
                order.id
              } has been resolved in favor of the seller: ${String(resolution).trim()}`,
              link: "/Orders?tab=Disputes_Raised",
            });
          }
          if (dispute.recievedBy?.id) {
            await createNotification({
              strapi,
              recipientId: dispute.recievedBy.id,
              type: "dispute_resolved",
              title: "Dispute Resolved - Stripe Payout Sent",
              body: `Dispute on Order #ORD-${order.id} was resolved in your favor. ${sellerAmount.toLocaleString()} THB has been transferred to your connected Stripe account (${transferId}).`,
              link: "/Orders?tab=Disputes_Recieved",
            });
          }

          return ctx.send({
            ok: true,
            action: "RELEASE_TO_SELLER",
            message: `Dispute resolved and ${sellerAmount.toLocaleString()} THB transferred to seller Stripe Connect account (${transferId}).`,
            status: "RESOLVED_RELEASE",
            payout: {
              id: payout.id,
              transferId,
              destinationAccountId,
              sellerAmount,
            },
            data: updatedDispute,
          });
        } else if (normalizedAction === "REQUEST_MORE_INFO") {
          const notesText = String(adminNotes || resolution || "").trim();
          if (!notesText) {
            return ctx.badRequest(
              "Please provide an explanation or request note for the buyer."
            );
          }

          const updatedDispute = await strapi.entityService.update(
            "api::dispute.dispute",
            dispute.id,
            {
              data: {
                status: "AWAITING_INFORMATION",
                adminNotes: notesText,
                resolution: `Admin requested additional info: ${notesText}`,
              } as any,
            }
          );

          if (order?.id) {
            await strapi.entityService.update("api::order.order", order.id, {
              data: { payoutStatus: "ON_HOLD" } as any,
            });
          }

          if (dispute.raisedBy?.id) {
            await createNotification({
              strapi,
              recipientId: dispute.raisedBy.id,
              type: "dispute_status_updated",
              title: "More Information Required on Dispute",
              body: `Admin requested additional info/image evidence for Order #ORD-${
                order?.id ?? dispute.id
              }: "${notesText}"`,
              link: "/Orders?tab=Disputes_Raised",
            });
          }

          return ctx.send({
            ok: true,
            action: "REQUEST_MORE_INFO",
            message:
              "Dispute status updated to Awaiting Information. Buyer has been notified.",
            status: "AWAITING_INFORMATION",
            data: updatedDispute,
          });
        } else if (
          [
            "MARK_RESOLVED",
            "RESOLVED",
            "REJECT_DISPUTE",
            "REJECTED",
            "CLOSE_DISPUTE",
            "CLOSED",
          ].includes(normalizedAction)
        ) {
          const targetStatus =
            normalizedAction === "MARK_RESOLVED" || normalizedAction === "RESOLVED"
              ? "RESOLVED"
              : normalizedAction === "REJECT_DISPUTE" || normalizedAction === "REJECTED"
              ? "REJECTED"
              : "CLOSED";

          const resolutionText = String(resolution || adminNotes || "").trim();
          if (!resolutionText) {
            return ctx.badRequest(
              `An admin note / resolution reason is required to mark dispute as ${targetStatus}.`
            );
          }

          const updatedDispute = await strapi.entityService.update(
            "api::dispute.dispute",
            dispute.id,
            {
              data: {
                status: targetStatus,
                resolvedAt: new Date(),
                adminDecision: targetStatus,
                resolution: resolutionText,
                adminNotes: adminNotes ?? dispute.adminNotes ?? resolutionText,
              } as any,
            }
          );

          if (order?.id) {
            const restoredPayoutStatus = computeRestoredPayoutStatus(order);
            await strapi.entityService.update("api::order.order", order.id, {
              data: { payoutStatus: restoredPayoutStatus } as any,
            });
          }

          if (dispute.raisedBy?.id) {
            await createNotification({
              strapi,
              recipientId: dispute.raisedBy.id,
              type: "dispute_resolved",
              title: `Dispute ${targetStatus.charAt(0) + targetStatus.slice(1).toLowerCase()}`,
              body: `Your dispute on Order #ORD-${
                order?.id ?? dispute.id
              } has been marked ${targetStatus}: ${resolutionText}`,
              link: "/Orders?tab=Disputes_Raised",
            });
          }
          if (dispute.recievedBy?.id) {
            await createNotification({
              strapi,
              recipientId: dispute.recievedBy.id,
              type: "dispute_resolved",
              title: `Dispute ${targetStatus.charAt(0) + targetStatus.slice(1).toLowerCase()}`,
              body: `The dispute on Order #ORD-${
                order?.id ?? dispute.id
              } has been marked ${targetStatus}.`,
              link: "/Orders?tab=Disputes_Recieved",
            });
          }

          return ctx.send({
            ok: true,
            action: normalizedAction,
            status: targetStatus,
            message: `Dispute marked as ${targetStatus}.`,
            data: updatedDispute,
          });
        } else {
          return ctx.badRequest(`Unknown action: ${action}`);
        }
      } catch (error) {
        strapi.log.error("Error in handleDisputeAction:", error);
        return ctx.internalServerError("Failed to execute dispute action.");
      }
    },

    /**
     * 5. GET /api/admin/disputes-full
     */
    async getDisputesFull(ctx) {
      try {
        const disputes = (await strapi.entityService.findMany(
          "api::dispute.dispute",
          {
            populate: {
              order: {
                populate: { buyer: true, seller: true, product: true },
              },
              raisedBy: true,
              recievedBy: true,
            },
            sort: { createdAt: "desc" },
          }
        )) as any[];

        const mapped = disputes.map((d: any) => {
          const order = d.order || {};
          const totalAmt = Number(order.totalAmount || 0);
          const commissionAmount = Math.round(totalAmt * 0.1 * 100) / 100;
          const sellerAmount = Math.round(totalAmt * 0.9 * 100) / 100;

          const isDelivered =
            (order.orderStatus || "").toLowerCase() === "delivered";
          const deliveredAt = isDelivered
            ? order.deliveredAt || order.updatedAt || order.createdAt
            : null;
          const disputeDeadline = deliveredAt
            ? new Date(
                new Date(deliveredAt).getTime() + 48 * 60 * 60 * 1000
              ).toISOString()
            : null;

          const s = (d.status || "OPEN").toUpperCase();
          const orderPayStatus = (order.paymentStatus || "").toLowerCase();
          const orderPayoutStatus = (order.payoutStatus || "NOT_ELIGIBLE").toUpperCase();
          let payoutHoldStatus = "ON_HOLD";
          if (orderPayStatus === "refunded" || s === "RESOLVED_REFUND") {
            payoutHoldStatus = "BLOCKED_REFUNDED";
          } else if (["PAID", "TRANSFERRED"].includes(orderPayoutStatus)) {
            payoutHoldStatus = "PAID";
          } else if (
            ["RESOLVED_RELEASE", "RESOLVED", "CLOSED", "REJECTED"].includes(s)
          ) {
            payoutHoldStatus = "RELEASED";
          }

          const sellerStripeId =
            d.recievedBy?.stripeAccountId || order.seller?.stripeAccountId || "";

          return {
            id: Number(d.id),
            documentId: d.documentId,
            disputeId: `DSP-${String(d.id).padStart(4, "0")}`,
            orderId: order.id || 0,
            orderNumber: `ORD-${String(order.id || 0).padStart(5, "0")}`,
            buyer: {
              id: d.raisedBy?.id || order.buyer?.id || 0,
              username:
                d.raisedBy?.username ||
                order.buyer?.username ||
                "Unknown Buyer",
              email: d.raisedBy?.email || order.buyer?.email || "",
            },
            seller: {
              id: d.recievedBy?.id || order.seller?.id || 0,
              username:
                d.recievedBy?.username ||
                order.seller?.username ||
                "Unknown Seller",
              email: d.recievedBy?.email || order.seller?.email || "",
              bankAccountLast4:
                d.recievedBy?.bankAccountLast4 ||
                order.seller?.bankAccountLast4 ||
                "",
              stripeAccountId: sellerStripeId,
              stripeConnectStatus: sellerStripeId ? "Connected" : "Not connected",
            },
            product: {
              id: order.product?.id || 0,
              title:
                order.productTitle ||
                order.product?.title ||
                "Product Item",
              image:
                order.productImage ||
                order.product?.image ||
                "",
              price: Number(
                order.productPrice || order.product?.price || totalAmt
              ),
            },
            orderAmount: totalAmt,
            commissionAmount,
            sellerAmount,
            reason: d.reason || "OTHER",
            description: d.description || "",
            evidence: d.evidence || null,
            status: s,
            resolution: d.resolution || null,
            adminNotes: d.adminNotes || null,
            adminDecision: d.adminDecision || null,
            stripeRefundId: d.stripeRefundId || null,
            refundStatus: d.refundStatus || "NONE",
            refundAmount: d.refundAmount ? Number(d.refundAmount) : totalAmt,
            resolvedAt: d.resolvedAt || null,
            orderPaymentStatus: order.paymentStatus || "pending",
            orderPayoutStatus,
            hasStripePayment: Boolean(order.paymentIntentId || order.chargeId),
            payoutHoldStatus,
            createdDate: d.createdAt,
            deliveryDate: deliveredAt,
            disputeDeadline,
            paymentDate: order.createdAt,
          };
        });

        return ctx.send({ ok: true, data: mapped });
      } catch (error) {
        strapi.log.error("Error in getDisputesFull:", error);
        return ctx.internalServerError("Failed to load disputes.");
      }
    },

    /**
     * 6. GET /api/admin/refunds
     */
    async getRefunds(ctx) {
      try {
        const disputes = (await strapi.entityService.findMany(
          "api::dispute.dispute",
          {
            populate: {
              order: { populate: { buyer: true, seller: true } },
              raisedBy: true,
              recievedBy: true,
            },
            sort: { createdAt: "desc" },
          }
        )) as any[];

        const list: any[] = [];

        for (const d of disputes) {
          const s = (d.status || "").toUpperCase();
          const isRefundDispute =
            s === "RESOLVED_REFUND" ||
            d.requestType === "REFUND_REQUEST" ||
            d.refundAmount ||
            ["ITEM_NOT_RECEIVED", "DAMAGED_PRODUCT", "WRONG_ITEM"].includes(
              d.reason
            );

          if (isRefundDispute && d.order?.id) {
            const amount = Number(
              d.refundAmount || d.order?.totalAmount || 0
            );

            let refundStatus = "REQUESTED";
            if (d.stripeRefundId) {
              refundStatus =
                d.refundStatus === "SUCCEEDED"
                  ? "SUCCEEDED"
                  : d.refundStatus === "PROCESSING" ||
                    d.refundStatus === "PENDING"
                  ? "PROCESSING"
                  : "FAILED";
            } else if (s === "RESOLVED_REFUND") {
              refundStatus = "FAILED";
            } else if (s === "UNDER_REVIEW") {
              refundStatus = "PROCESSING";
            } else if (s === "CLOSED" || s === "REJECTED") {
              refundStatus = "CANCELLED";
            }

            list.push({
              id: Number(d.id),
              refundId: `REF-${String(d.id).padStart(4, "0")}`,
              orderId: Number(d.order.id),
              orderNumber: `ORD-${String(d.order.id).padStart(5, "0")}`,
              buyer:
                d.raisedBy?.username || d.order.buyer?.username || "Buyer",
              seller:
                d.recievedBy?.username || d.order.seller?.username || "Seller",
              refundAmount: amount,
              reason: d.reason || "Dispute Refund Request",
              stripeRefundId: d.stripeRefundId || "",
              status: refundStatus,
              requestDate: d.createdAt,
              processingDate: d.updatedAt,
              completionDate:
                s === "RESOLVED_REFUND" ? d.updatedAt : null,
            });
          }
        }

        return ctx.send({ ok: true, data: list });
      } catch (error) {
        strapi.log.error("Error in getRefunds:", error);
        return ctx.internalServerError("Failed to load refunds.");
      }
    },

    /**
     * 7. GET /api/admin/transactions
     */
    async getTransactions(ctx) {
      try {
        const orders = (await strapi.entityService.findMany(
          "api::order.order",
          {
            populate: { buyer: true, seller: true },
            sort: { createdAt: "desc" },
          }
        )) as any[];

        const payouts = (await strapi.entityService.findMany(
          "api::payout.payout",
          {
            populate: { order: true, seller: true },
            sort: { createdAt: "desc" },
          }
        )) as any[];

        const disputes = (await strapi.entityService.findMany(
          "api::dispute.dispute",
          {
            filters: { status: "RESOLVED_REFUND" } as any,
            populate: { order: true, raisedBy: true },
            sort: { updatedAt: "desc" },
          }
        )) as any[];

        const txs: any[] = [];

        for (const o of orders) {
          const totalAmt = Number(o.totalAmount || 0);
          const isPaid =
            (o.paymentStatus || "").toLowerCase() === "paid" ||
            (o.paymentStatus || "").toLowerCase() === "refunded";
          const orderRef = `ORD-${String(o.id).padStart(5, "0")}`;

          if (isPaid && totalAmt > 0 && (o.paymentIntentId || o.chargeId)) {
            txs.push({
              id: `TX-PAY-${o.id}`,
              orderId: orderRef,
              type: "CUSTOMER_PAYMENT",
              amount: totalAmt,
              currency: "THB",
              stripeReference: o.paymentIntentId || o.chargeId,
              status: "COMPLETED",
              initiatedBy: o.buyer?.username || "Customer",
              createdAt: o.createdAt,
              processedAt: o.createdAt,
            });

            const commAmt = Math.round(totalAmt * 0.1 * 100) / 100;
            txs.push({
              id: `TX-COM-${o.id}`,
              orderId: orderRef,
              type: "PLATFORM_COMMISSION",
              amount: commAmt,
              currency: "THB",
              stripeReference: "",
              status: "COMPLETED",
              initiatedBy: "System",
              createdAt: o.createdAt,
              processedAt: o.createdAt,
            });
          }
        }

        for (const po of payouts) {
          if (
            po.isMock === true ||
            (!po.stripePayoutId && !po.stripeTransferId)
          ) {
            continue;
          }
          const orderRef = po.order?.id
            ? `ORD-${String(po.order.id).padStart(5, "0")}`
            : `PO-${po.id}`;
          const status =
            (po.status || "").toLowerCase() === "success" ||
            (po.status || "").toLowerCase() === "paid"
              ? "COMPLETED"
              : (po.status || "").toUpperCase();

          txs.push({
            id: `TX-PO-${po.id}`,
            orderId: orderRef,
            type: "SELLER_BANK_PAYOUT",
            amount: Number(po.netAmount || 0),
            currency: "THB",
            stripeReference: po.stripePayoutId || po.stripeTransferId,
            status,
            initiatedBy: "Admin",
            createdAt: po.createdAt,
            processedAt: po.processedAt || po.updatedAt || po.createdAt,
          });
        }

        for (const d of disputes) {
          if (!d.stripeRefundId) continue;
          const orderRef = d.order?.id
            ? `ORD-${String(d.order.id).padStart(5, "0")}`
            : `DSP-${d.id}`;
          const amt = Number(d.refundAmount || d.order?.totalAmount || 0);

          txs.push({
            id: `TX-REF-${d.id}`,
            orderId: orderRef,
            type: "BUYER_REFUND",
            amount: amt,
            currency: "THB",
            stripeReference: d.stripeRefundId,
            status:
              d.refundStatus === "SUCCEEDED"
                ? "COMPLETED"
                : d.refundStatus === "PROCESSING" ||
                  d.refundStatus === "PENDING"
                ? "PENDING"
                : "FAILED",
            initiatedBy: "Admin",
            createdAt: d.updatedAt || d.createdAt,
            processedAt: d.updatedAt || d.createdAt,
          });
        }

        txs.sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );

        return ctx.send({ ok: true, data: txs });
      } catch (error) {
        strapi.log.error("Error in getTransactions:", error);
        return ctx.internalServerError("Failed to load transactions.");
      }
    },

    /**
     * 8. GET /api/admin/seller-payout-profiles
     */
    async getSellerPayoutProfiles(ctx) {
      try {
        const users = (await strapi.entityService.findMany(
          "plugin::users-permissions.user",
          {
            populate: { role: true },
          }
        )) as any[];

        const orders = (await strapi.entityService.findMany(
          "api::order.order",
          {
            populate: { seller: true },
          }
        )) as any[];

        const payouts = (await strapi.entityService.findMany(
          "api::payout.payout",
          {
            populate: { seller: true },
          }
        )) as any[];

        const profiles = users.map((u: any) => {
          const userOrders = orders.filter((o: any) => o.seller?.id === u.id);
          const userPayouts = payouts.filter((p: any) => p.seller?.id === u.id);

          let pendingEarnings = 0;
          let eligibleEarnings = 0;
          let completedPayoutsTotal = 0;

          const now = Date.now();
          for (const o of userOrders) {
            const isPaid = (o.paymentStatus || "").toLowerCase() === "paid";
            const isDelivered =
              (o.orderStatus || "").toLowerCase() === "delivered";
            const isRefunded =
              (o.paymentStatus || "").toLowerCase() === "refunded";

            if (isPaid && !isRefunded) {
              const netAmt = Number(o.totalAmount || 0) * 0.9;
              const hasPayout = userPayouts.some(
                (p: any) =>
                  p.order?.id === o.id &&
                  p.isMock !== true &&
                  (p.stripeTransferId || p.stripePayoutId) &&
                  ["success", "paid"].includes((p.status || "").toLowerCase())
              );

              if (!hasPayout) {
                if (isDelivered) {
                  const delTime = new Date(
                    o.deliveredAt || o.updatedAt || o.createdAt
                  ).getTime();
                  if (now >= delTime + 48 * 3600 * 1000) {
                    eligibleEarnings += netAmt;
                  } else {
                    pendingEarnings += netAmt;
                  }
                } else {
                  pendingEarnings += netAmt;
                }
              }
            }
          }

          for (const p of userPayouts) {
            if (
              p.isMock !== true &&
              (p.stripeTransferId || p.stripePayoutId) &&
              ["success", "paid"].includes((p.status || "").toLowerCase())
            ) {
              completedPayoutsTotal += Number(p.netAmount || 0);
            }
          }

          return {
            sellerId: Number(u.id),
            name: u.username || `User #${u.id}`,
            email: u.email || "",
            bankName: u.bankName || "Not provided",
            maskedAccountNumber: u.bankAccountLast4
              ? `•••• ${u.bankAccountLast4}`
              : "Not provided",
            stripeConnectStatus: u.stripeAccountId ? "Connected" : "Not connected",
            pendingEarnings: Math.round(pendingEarnings * 100) / 100,
            eligibleEarnings: Math.round(eligibleEarnings * 100) / 100,
            completedPayouts: Math.round(completedPayoutsTotal * 100) / 100,
          };
        });

        return ctx.send({ ok: true, data: profiles });
      } catch (error) {
        strapi.log.error("Error in getSellerPayoutProfiles:", error);
        return ctx.internalServerError("Failed to load seller payout profiles.");
      }
    },

    // ──────────────────────────────────────────────────────────────────────────
    // Section 10 Standardized RESTful APIs
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * GET /admin/disputes
     */
    async getAdminDisputes(ctx) {
      try {
        const disputes = (await strapi.entityService.findMany(
          "api::dispute.dispute",
          {
            populate: {
              order: { populate: { buyer: true, seller: true, product: true } },
              raisedBy: true,
              recievedBy: true,
            },
            sort: { createdAt: "desc" },
          }
        )) as any[];

        return ctx.send({ ok: true, data: disputes });
      } catch (err) {
        strapi.log.error("Error in getAdminDisputes:", err);
        return ctx.internalServerError("Failed to load disputes.");
      }
    },

    /**
     * GET /admin/disputes/:id
     */
    async getAdminDisputeById(ctx) {
      try {
        const { id } = ctx.params;
        const dispute = await strapi.entityService.findOne(
          "api::dispute.dispute",
          Number(id),
          {
            populate: {
              order: { populate: { buyer: true, seller: true, product: true } },
              raisedBy: true,
              recievedBy: true,
            },
          }
        );
        if (!dispute) return ctx.notFound("Dispute not found.");
        return ctx.send({ ok: true, data: dispute });
      } catch (err) {
        strapi.log.error("Error in getAdminDisputeById:", err);
        return ctx.internalServerError("Failed to get dispute.");
      }
    },

    /**
     * PATCH /admin/disputes/:id/status
     */
    async updateAdminDisputeStatus(ctx) {
      try {
        const { id } = ctx.params;
        const { status, adminNotes, resolution } = ctx.request.body || {};

        const existing = await findDisputeWithRelations(strapi, id);
        if (!existing) return ctx.notFound("Dispute not found.");

        const normalizedStatus = status
          ? String(status).trim().toUpperCase()
          : null;
        const data: any = {};
        if (normalizedStatus) data.status = normalizedStatus;
        if (adminNotes !== undefined) data.adminNotes = adminNotes;
        if (resolution !== undefined) data.resolution = resolution;
        if (
          normalizedStatus &&
          FINALIZED_DISPUTE_STATUSES.includes(normalizedStatus)
        ) {
          data.resolvedAt = new Date();
        }

        const updated = await strapi.entityService.update(
          "api::dispute.dispute",
          existing.id,
          { data }
        );

        if (existing.order?.id && normalizedStatus) {
          if (
            ["OPEN", "UNDER_REVIEW", "AWAITING_INFORMATION"].includes(
              normalizedStatus
            )
          ) {
            await strapi.entityService.update(
              "api::order.order",
              existing.order.id,
              { data: { payoutStatus: "ON_HOLD" } as any }
            );
          } else if (
            ["RESOLVED", "REJECTED", "CLOSED"].includes(normalizedStatus)
          ) {
            await strapi.entityService.update(
              "api::order.order",
              existing.order.id,
              { data: { payoutStatus: computeRestoredPayoutStatus(existing.order) } as any }
            );
          }
        }

        if (normalizedStatus && existing.raisedBy?.id) {
          await createNotification({
            strapi,
            recipientId: existing.raisedBy.id,
            type: "dispute_status_updated",
            title: "Dispute Status Updated",
            body: `Your dispute on Order #ORD-${existing.order?.id ?? existing.id} is now ${normalizedStatus.replace(/_/g, " ")}.`,
            link: "/Orders?tab=Disputes_Raised",
          });
        }

        return ctx.send({
          ok: true,
          message: "Dispute status updated.",
          data: updated,
        });
      } catch (err) {
        strapi.log.error("Error updating dispute status:", err);
        return ctx.internalServerError("Failed to update dispute status.");
      }
    },

    /**
     * POST /admin/disputes/:id/refund
     * (Action A: Refund Buyer via Stripe)
     */
    async adminRefundBuyer(ctx) {
      try {
        const { id } = ctx.params;
        const { resolution, adminNotes, refundAmount } = ctx.request.body || {};

        const dispute = await findDisputeWithRelations(strapi, id);
        if (!dispute) return ctx.notFound("Dispute not found.");

        const order = dispute.order;
        const effectiveAmount =
          refundAmount !== undefined && refundAmount !== ""
            ? Number(refundAmount)
            : Number(dispute.refundAmount || order?.totalAmount || 0);

        const refundTarget = getStripeRefundTarget(order);
        if (!refundTarget) {
          return ctx.badRequest(
            "Cannot issue refund: this order has no Stripe payment intent or charge."
          );
        }
        if (!Number.isFinite(effectiveAmount) || effectiveAmount <= 0) {
          return ctx.badRequest("Refund amount must be greater than zero.");
        }
        if (dispute.stripeRefundId && dispute.refundStatus !== "FAILED") {
          return ctx.badRequest(
            "A Stripe refund has already been created for this dispute."
          );
        }
        if ((order?.paymentStatus || "").toLowerCase() === "refunded") {
          return ctx.badRequest("This order has already been refunded.");
        }

        let refund: any;
        try {
          refund = await stripe.refunds.create({
            ...refundTarget,
            amount: Math.round(effectiveAmount * 100),
            metadata: {
              disputeId: String(dispute.id),
              orderId: String(order?.id || ""),
            },
          });
        } catch (stripeErr: any) {
          return ctx.badRequest(
            `Stripe Refund failed: ${stripeErr?.message || "Unknown error"}`
          );
        }

        const succeeded = refund.status === "succeeded";

        await strapi.entityService.update("api::dispute.dispute", dispute.id, {
          data: {
            status: succeeded ? "RESOLVED_REFUND" : "UNDER_REVIEW",
            refundStatus:
              refund.status === "succeeded"
                ? "SUCCEEDED"
                : refund.status === "pending"
                ? "PROCESSING"
                : "FAILED",
            resolvedAt: succeeded ? new Date() : null,
            adminDecision: "REFUND_BUYER",
            stripeRefundId: refund.id,
            resolution:
              resolution ||
              `Refund of ${effectiveAmount} THB submitted to Stripe (${refund.id}).`,
            adminNotes: adminNotes ?? dispute.adminNotes ?? null,
            refundAmount: effectiveAmount,
          } as any,
        });

        if (order?.id) {
          await strapi.entityService.update("api::order.order", order.id, {
            data: {
              ...(succeeded ? { paymentStatus: "refunded" } : {}),
              payoutStatus: succeeded ? "CANCELLED" : "ON_HOLD",
            } as any,
          });
        }

        if (succeeded && dispute.raisedBy?.id) {
          await createNotification({
            strapi,
            recipientId: dispute.raisedBy.id,
            type: "refund_processed",
            title: "Refund Approved & Processed",
            body: `Your refund of ${effectiveAmount} THB has been refunded via Stripe (${refund.id}).`,
            link: "/Orders?tab=Disputes_Raised",
          });
        }
        if (succeeded && dispute.recievedBy?.id) {
          await createNotification({
            strapi,
            recipientId: dispute.recievedBy.id,
            type: "dispute_resolved",
            title: "Dispute Resolved (Buyer Refunded)",
            body: `Dispute on Order #ORD-${order?.id ?? dispute.id} was resolved with a buyer refund. Seller payout cancelled.`,
            link: "/Orders?tab=Disputes_Recieved",
          });
        }

        return ctx.send({
          ok: true,
          message: succeeded
            ? `Buyer refund of ${effectiveAmount} THB succeeded (${refund.id}). Seller payout cancelled.`
            : `Stripe refund is ${refund.status}; the dispute remains under review.`,
          refundId: refund.id,
          status: succeeded ? "RESOLVED_REFUND" : "UNDER_REVIEW",
        });
      } catch (err) {
        strapi.log.error("Error in adminRefundBuyer:", err);
        return ctx.internalServerError("Failed to process buyer refund.");
      }
    },

    /**
     * POST /admin/disputes/:id/release
     * (Action B: Release & Transfer Payment to Seller Stripe Connect Account)
     */
    async adminReleaseToSeller(ctx) {
      try {
        const { id } = ctx.params;
        const { resolution, adminNotes } = ctx.request.body || {};

        if (!resolution || !String(resolution).trim()) {
          return ctx.badRequest(
            "Admin resolution note is required to release payout to seller."
          );
        }

        const dispute = await findDisputeWithRelations(strapi, id);
        if (!dispute) return ctx.notFound("Dispute not found.");
        if (!dispute.order?.id) {
          return ctx.badRequest("No linked order found for this dispute.");
        }

        const transferResult = await executeSellerPayoutForOrder(strapi, {
          orderId: dispute.order.id,
          notes: `Dispute #${dispute.id} resolved in seller favor: ${String(resolution).trim()}`,
          fallbackOrderPayoutStatus: "ON_HOLD",
        });

        if (!transferResult.ok) {
          return ctx.badRequest(transferResult.message);
        }

        const { sellerAmount, transferId, destinationAccountId } =
          transferResult;

        await strapi.entityService.update("api::dispute.dispute", dispute.id, {
          data: {
            status: "RESOLVED_RELEASE",
            resolvedAt: new Date(),
            adminDecision: "RELEASE_TO_SELLER",
            resolution: String(resolution).trim(),
            adminNotes: adminNotes ?? dispute.adminNotes ?? null,
          } as any,
        });

        if (dispute.raisedBy?.id) {
          await createNotification({
            strapi,
            recipientId: dispute.raisedBy.id,
            type: "dispute_resolved",
            title: "Dispute Resolved (Released to Seller)",
            body: `Your dispute on order #${dispute.order.id} was resolved in favor of the seller: "${String(resolution).trim()}".`,
            link: "/Orders?tab=Disputes_Raised",
          });
        }
        if (dispute.recievedBy?.id) {
          await createNotification({
            strapi,
            recipientId: dispute.recievedBy.id,
            type: "dispute_resolved",
            title: "Dispute Resolved - Stripe Payout Sent",
            body: `Dispute on order #${dispute.order.id} was resolved in your favor. ${sellerAmount.toLocaleString()} THB transferred to your Stripe Connect account (${transferId}).`,
            link: "/Orders?tab=Disputes_Recieved",
          });
        }

        return ctx.send({
          ok: true,
          message: `Dispute resolved and ${sellerAmount.toLocaleString()} THB transferred to seller Stripe Connect account (${transferId}).`,
          status: "RESOLVED_RELEASE",
          payout: {
            transferId,
            destinationAccountId,
            sellerAmount,
          },
        });
      } catch (err) {
        strapi.log.error("Error in adminReleaseToSeller:", err);
        return ctx.internalServerError("Failed to release dispute to seller.");
      }
    },

    /**
     * GET /admin/payouts
     */
    async getAdminPayouts(ctx) {
      try {
        const payouts = await strapi.entityService.findMany(
          "api::payout.payout",
          {
            populate: { order: { populate: ["buyer", "seller"] }, seller: true },
            sort: { createdAt: "desc" },
          }
        );
        return ctx.send({
          ok: true,
          data: payouts.filter((payout: any) => payout.isMock !== true),
        });
      } catch (err) {
        strapi.log.error("Error in getAdminPayouts:", err);
        return ctx.internalServerError("Failed to load payouts.");
      }
    },

    /**
     * GET /admin/payouts/:id
     */
    async getAdminPayoutById(ctx) {
      try {
        const { id } = ctx.params;
        const payout = await strapi.entityService.findOne(
          "api::payout.payout",
          Number(id),
          { populate: { order: true, seller: true } }
        );
        if (!payout || (payout as any).isMock === true) {
          return ctx.notFound("Payout not found.");
        }
        return ctx.send({ ok: true, data: payout });
      } catch (err) {
        strapi.log.error("Error in getAdminPayoutById:", err);
        return ctx.internalServerError("Failed to get payout.");
      }
    },

    /**
     * POST /admin/payouts/:id/release
     */
    async adminReleasePayout(ctx) {
      try {
        const { id } = ctx.params;
        const { notes } = ctx.request.body || {};

        ctx.request.body = { orderId: Number(id), notes };
        return await (this as any).releasePayout(ctx);
      } catch (err) {
        strapi.log.error("Error in adminReleasePayout:", err);
        return ctx.internalServerError("Failed to release payout.");
      }
    },

    /**
     * GET /admin/payouts/:id/history
     */
    async getAdminPayoutHistory(ctx) {
      try {
        const { id } = ctx.params;
        const orderId = Number(id);

        const order = (await strapi.entityService.findOne(
          "api::order.order",
          orderId,
          { populate: { buyer: true, seller: true } }
        )) as any;

        if (!order) return ctx.notFound("Order not found.");

        const payouts = (await strapi.entityService.findMany(
          "api::payout.payout",
          { filters: { order: { id: orderId } } as any }
        )) as any[];

        const disputes = (await strapi.entityService.findMany(
          "api::dispute.dispute",
          { filters: { order: { id: orderId } } as any }
        )) as any[];

        const history: any[] = [];

        // Order placement
        history.push({
          event: "ORDER_PLACED",
          timestamp: order.createdAt,
          details: `Order placed for ${order.totalAmount} THB by ${order.buyer?.username || "Buyer"}`,
        });

        // Delivery
        if (order.deliveredAt) {
          history.push({
            event: "DELIVERED",
            timestamp: order.deliveredAt,
            details: `Order marked delivered. 48h dispute deadline set to ${order.disputeDeadline}`,
          });
        }

        // Disputes
        for (const d of disputes) {
          history.push({
            event: `DISPUTE_${d.status}`,
            timestamp: d.updatedAt || d.createdAt,
            details: `Dispute #${d.id} (${d.reason}): ${d.description || ""}`,
          });
        }

        // Payout releases
        for (const p of payouts) {
          history.push({
            event: `PAYOUT_${(p.status || "").toUpperCase()}`,
            timestamp: p.processedAt || p.createdAt,
            details:
              p.isMock === true || (!p.stripeTransferId && !p.stripePayoutId)
                ? "No external transfer was recorded."
                : `Payout of ${p.netAmount} THB processed through Stripe Connect.`,
            transferId: p.stripeTransferId || null,
          });
        }

        return ctx.send({ ok: true, data: history });
      } catch (err) {
        strapi.log.error("Error in getAdminPayoutHistory:", err);
        return ctx.internalServerError("Failed to retrieve payout history.");
      }
    },

    /**
     * POST /stripe/webhook
     * Handles Stripe Webhook events with signature verification and deduplication
     */
    async handleStripeWebhook(ctx) {
      try {
        const event = ctx.request.body;

        if (!event || !event.type || !event.id) {
          return ctx.badRequest("Invalid webhook payload.");
        }

        // Deduplication check
        if (processedWebhookEventIds.has(event.id)) {
          return ctx.send({ received: true, deduplicated: true });
        }
        processedWebhookEventIds.add(event.id);

        const eventType = event.type;
        strapi.log.info(`[STRIPE WEBHOOK] Received event: ${eventType} (${event.id})`);

        switch (eventType) {
          case "payment_intent.succeeded": {
            const pi = event.data?.object;
            const orderId = pi?.metadata?.orderId;
            if (orderId) {
              await strapi.entityService.update("api::order.order", Number(orderId), {
                data: {
                  paymentStatus: "paid",
                  paymentIntentId: pi.id,
                  payoutStatus: "NOT_ELIGIBLE",
                } as any,
              });
            }
            break;
          }

          case "payment_intent.payment_failed": {
            const pi = event.data?.object;
            const orderId = pi?.metadata?.orderId;
            if (orderId) {
              await strapi.entityService.update("api::order.order", Number(orderId), {
                data: { paymentStatus: "failed" } as any,
              });
            }
            break;
          }

          case "charge.refunded":
          case "refund.updated": {
            const refund = event.data?.object;
            strapi.log.info(`[STRIPE WEBHOOK] Refund processed: ${refund.id}`);
            break;
          }

          case "charge.dispute.created": {
            // Stripe Chargeback received!
            const stripeDispute = event.data?.object;
            strapi.log.warn(`[STRIPE CHARGEBACK] Received dispute: ${stripeDispute.id}`);
            break;
          }

          default:
            strapi.log.info(`[STRIPE WEBHOOK] Unhandled event type: ${eventType}`);
        }

        return ctx.send({ received: true });
      } catch (err) {
        strapi.log.error("Error processing Stripe webhook:", err);
        return ctx.internalServerError("Webhook handler failed.");
      }
    },

    /**
     * POST /api/stripe-connect/onboard
     * Creates (or reuses) a seller's Stripe Connect Express account and returns an onboarding link.
     */
    async onboardStripeConnect(ctx) {
      try {
        const userId = await getAuthenticatedUserId(strapi, ctx);
        if (!userId) {
          return ctx.unauthorized("Authentication required.");
        }

        const user = (await strapi.entityService.findOne(
          "plugin::users-permissions.user",
          userId
        )) as any;
        if (!user) return ctx.notFound("User not found.");

        const body = ctx.request.body || {};
        const origin =
          String(ctx.request.headers?.origin || "").trim() ||
          process.env.FRONTEND_URL ||
          "http://localhost:3000";
        const returnUrl =
          String(body.returnUrl || "").trim() ||
          `${origin}/setting?tab=payments&stripe_connect=return`;
        const refreshUrl =
          String(body.refreshUrl || "").trim() ||
          `${origin}/setting?tab=payments&stripe_connect=refresh`;

        let stripeAccountId = user.stripeAccountId;
        if (!stripeAccountId) {
          const account = await stripe.accounts.create({
            type: "express",
            country: process.env.STRIPE_CONNECT_COUNTRY || "TH",
            email: user.email || undefined,
            capabilities: {
              card_payments: { requested: true },
              transfers: { requested: true },
            },
            metadata: {
              userId: String(user.id),
            },
          });
          stripeAccountId = account.id;
          await strapi.entityService.update(
            "plugin::users-permissions.user",
            user.id,
            {
              data: {
                stripeAccountId,
                stripeConnectStatus: "Pending",
              } as any,
            }
          );
        }

        const accountLink = await stripe.accountLinks.create({
          account: stripeAccountId,
          refresh_url: refreshUrl,
          return_url: returnUrl,
          type: "account_onboarding",
        });

        return ctx.send({
          ok: true,
          url: accountLink.url,
          stripeAccountId,
        });
      } catch (err: any) {
        strapi.log.error("Error in onboardStripeConnect:", err);
        return ctx.badRequest(
          err?.message || "Failed to initialize Stripe Connect onboarding."
        );
      }
    },

    /**
     * GET /api/stripe-connect/status
     * Syncs and returns the signed-in seller's Stripe Connect onboarding & payout status.
     */
    async getStripeConnectStatus(ctx) {
      try {
        const userId = await getAuthenticatedUserId(strapi, ctx);
        if (!userId) {
          return ctx.unauthorized("Authentication required.");
        }

        const user = (await strapi.entityService.findOne(
          "plugin::users-permissions.user",
          userId
        )) as any;
        if (!user) return ctx.notFound("User not found.");

        if (!user.stripeAccountId) {
          return ctx.send({
            ok: true,
            connected: false,
            payoutsEnabled: false,
            chargesEnabled: false,
            detailsSubmitted: false,
            status: "Not connected",
            stripeAccountId: null,
            bankName: user.bankName || null,
            bankAccountLast4: user.bankAccountLast4 || null,
          });
        }

        const account = (await stripe.accounts.retrieve(user.stripeAccountId, {
          expand: ["external_accounts"],
        })) as any;

        const payoutsEnabled = Boolean(account.payouts_enabled);
        const chargesEnabled = Boolean(account.charges_enabled);
        const detailsSubmitted = Boolean(account.details_submitted);
        const transfersActive =
          account.capabilities?.transfers === "active" || payoutsEnabled;
        const connected = transfersActive || detailsSubmitted;

        const bankAccount = account.external_accounts?.data?.[0];
        const bankName = bankAccount?.bank_name || user.bankName || null;
        const bankAccountLast4 =
          bankAccount?.last4 || user.bankAccountLast4 || null;
        const statusLabel = payoutsEnabled
          ? "Connected"
          : detailsSubmitted
          ? "Verification Pending"
          : "Pending";

        await strapi.entityService.update(
          "plugin::users-permissions.user",
          user.id,
          {
            data: {
              stripeConnectStatus: statusLabel,
              ...(bankName ? { bankName } : {}),
              ...(bankAccountLast4 ? { bankAccountLast4 } : {}),
            } as any,
          }
        );

        return ctx.send({
          ok: true,
          connected,
          payoutsEnabled,
          chargesEnabled,
          detailsSubmitted,
          status: statusLabel,
          stripeAccountId: user.stripeAccountId,
          bankName,
          bankAccountLast4,
        });
      } catch (err: any) {
        strapi.log.error("Error in getStripeConnectStatus:", err);
        return ctx.badRequest(
          err?.message || "Failed to fetch Stripe Connect status."
        );
      }
    },
  })
);
