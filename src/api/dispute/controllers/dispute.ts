/**
 * dispute controller
 */

import { factories } from "@strapi/strapi";
import { createNotification } from "../../../lib/createNotification";

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

function mergeEvidenceUrls(existing: unknown, incoming: unknown): string | null {
  const parseList = (raw: unknown): string[] => {
    if (Array.isArray(raw)) {
      return raw.map((u) => String(u || "").trim()).filter(Boolean);
    }
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (!trimmed) return [];
      if (trimmed.startsWith("[")) {
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) {
            return parsed.map((u) => String(u || "").trim()).filter(Boolean);
          }
        } catch {}
      }
      return trimmed
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
    }
    return [];
  };

  const merged = Array.from(new Set([...parseList(existing), ...parseList(incoming)]));
  return merged.length > 0 ? merged.join("\n") : null;
}

export default factories.createCoreController(
  "api::dispute.dispute",
  ({ strapi }) => ({
    async fileDispute(ctx) {
      try {
        const payload = ctx.request.body?.data || ctx.request.body || {};
        const orderId = Number(payload.order?.id ?? payload.order);
        if (!Number.isInteger(orderId) || orderId <= 0) {
          return ctx.badRequest("A valid order ID is required.");
        }

        const orderRecord = (await strapi.entityService.findOne(
          "api::order.order",
          orderId,
          { populate: { buyer: true, seller: true } },
        )) as any;
        if (!orderRecord) {
          return ctx.notFound("Order not found.");
        }

        const payoutStatus = (orderRecord.payoutStatus || "").toUpperCase();
        if (["PROCESSING", "PAID", "TRANSFERRED"].includes(payoutStatus)) {
          return ctx.badRequest(
            "Cannot file dispute: Seller payout is already being processed or completed.",
          );
        }

        // Block duplicate active disputes from same buyer on same order
        const disputeExisting = (await strapi.entityService.findMany(
          "api::dispute.dispute",
          {
            filters: {
              order: { id: orderId },
            } as any,
          },
        )) as any[];

        const activeExists = disputeExisting.some((d: any) =>
          ["OPEN", "UNDER_REVIEW", "AWAITING_INFORMATION"].includes(
            (d.status || "").toUpperCase(),
          ),
        );
        if (activeExists) {
          return ctx.badRequest(
            "An active dispute already exists for this order.",
          );
        }

        const raisedById = Number(payload.raisedBy || orderRecord.buyer?.id);
        const sellerId = Number(payload.sellerId || orderRecord.seller?.id);
        const hasRefundAmount =
          payload.refundAmount !== undefined &&
          payload.refundAmount !== null &&
          payload.refundAmount !== "";
        const isRefundRequest =
          payload.requestType === "REFUND_REQUEST" || hasRefundAmount;

        // Place order payout immediately on hold while dispute is active
        await strapi.entityService.update("api::order.order", orderId, {
          data: { payoutStatus: "ON_HOLD" } as any,
        });

        // Create the dispute
        const newDispute = (await strapi.entityService.create(
          "api::dispute.dispute",
          {
            data: {
              order: { id: orderId },
              recievedBy: sellerId ? { id: sellerId } : undefined,
              raisedBy: raisedById ? { id: raisedById } : undefined,
              requestType: isRefundRequest ? "REFUND_REQUEST" : "DISPUTE",
              reason: payload.reason || "OTHER",
              description: payload.details ?? payload.description ?? null,
              evidence: mergeEvidenceUrls(null, payload.evidence),
              status: "OPEN",
              refundStatus: isRefundRequest ? "PENDING" : "NONE",
              refundAmount: hasRefundAmount
                ? Number(payload.refundAmount)
                : Number(orderRecord.totalAmount || 0) || null,
            } as any,
          },
        )) as any;

        if (newDispute && sellerId) {
          await createNotification({
            strapi,
            recipientId: sellerId,
            type: "dispute_received",
            title: isRefundRequest
              ? "Refund Request Received - Payout On Hold"
              : "New Dispute Received - Payout On Hold",
            body: `You received a ${isRefundRequest ? "refund request" : "dispute"} (${newDispute.reason}) on Order #${orderId}. Payout has been placed on hold pending review.`,
            link: `/Orders?tab=Disputes_Recieved`,
          });
        }

        return ctx.created(newDispute);
      } catch (error) {
        console.error("Error filing dispute:", error);
        return ctx.internalServerError(
          "An error occurred while filing the dispute.",
        );
      }
    },

    /**
     * POST /api/disputes/:id/submit-information
     * Buyer submits requested information / image evidence when dispute is AWAITING_INFORMATION.
     * Automatically moves status back to UNDER_REVIEW.
     */
    async submitBuyerInfo(ctx) {
      try {
        const authenticatedUserId = await getAuthenticatedUserId(strapi, ctx);
        if (!authenticatedUserId) {
          return ctx.unauthorized("Authentication required.");
        }

        const { id } = ctx.params;
        const body = ctx.request.body?.data || ctx.request.body || {};
        const messageText = String(
          body.message ?? body.details ?? body.additionalInfo ?? "",
        ).trim();
        const incomingEvidence = body.evidenceUrls ?? body.evidence;
        const mergedIncoming = mergeEvidenceUrls(null, incomingEvidence);

        if (!messageText && !mergedIncoming) {
          return ctx.badRequest(
            "Please provide additional explanation or upload image evidence.",
          );
        }

        let dispute: any = null;
        const numericId = Number(id);
        if (Number.isInteger(numericId) && numericId > 0) {
          dispute = await strapi.entityService.findOne(
            "api::dispute.dispute",
            numericId,
            {
              populate: {
                order: { populate: { buyer: true, seller: true } },
                raisedBy: true,
                recievedBy: true,
              },
            },
          );
        } else {
          const rows = (await strapi.entityService.findMany(
            "api::dispute.dispute",
            {
              filters: { documentId: id } as any,
              populate: {
                order: { populate: { buyer: true, seller: true } },
                raisedBy: true,
                recievedBy: true,
              },
            },
          )) as any[];
          dispute = rows?.[0];
        }

        if (!dispute) {
          return ctx.notFound("Dispute not found.");
        }

        const buyerId = Number(
          dispute.raisedBy?.id || dispute.order?.buyer?.id,
        );
        if (!buyerId || buyerId !== authenticatedUserId) {
          return ctx.forbidden(
            "Only the buyer who raised this dispute can submit additional information.",
          );
        }

        const currentStatus = (dispute.status || "OPEN").toUpperCase();
        if (
          [
            "RESOLVED_REFUND",
            "RESOLVED_RELEASE",
            "RESOLVED",
            "REJECTED",
            "CLOSED",
          ].includes(currentStatus)
        ) {
          return ctx.badRequest(
            "This dispute has already been finalized and cannot accept further updates.",
          );
        }

        const timestamp = new Date().toISOString().split("T")[0];
        const appendedDescription = messageText
          ? [
              dispute.description || "",
              `[Buyer Additional Info - ${timestamp}]: ${messageText}`,
            ]
              .filter(Boolean)
              .join("\n\n")
          : dispute.description || null;

        const nextEvidence = mergeEvidenceUrls(
          dispute.evidence,
          incomingEvidence,
        );

        const updatedDispute = (await strapi.entityService.update(
          "api::dispute.dispute",
          dispute.id,
          {
            data: {
              status: "UNDER_REVIEW",
              description: appendedDescription,
              evidence: nextEvidence,
            } as any,
          },
        )) as any;

        const sellerId = Number(
          dispute.recievedBy?.id || dispute.order?.seller?.id,
        );
        if (sellerId) {
          await createNotification({
            strapi,
            recipientId: sellerId,
            type: "dispute_status_updated",
            title: "Buyer Provided Additional Evidence",
            body: `Buyer submitted additional information for Order #${dispute.order?.id ?? dispute.id}. Status moved to Under Review.`,
            link: "/Orders?tab=Disputes_Recieved",
          });
        }

        return ctx.send({
          ok: true,
          message:
            "Additional information submitted. Your dispute is now Under Review.",
          status: "UNDER_REVIEW",
          data: updatedDispute,
        });
      } catch (error) {
        console.error("Error submitting buyer dispute info:", error);
        return ctx.internalServerError(
          "Failed to submit additional information.",
        );
      }
    },
    async UpdateDisputeStatus(ctx) {
  try {
    const { data } = ctx.request.body;

    // Update dispute
    await strapi.entityService.update(
      "api::dispute.dispute",
      data.disputeId,
      {
        data: {
          status: data.status,
          resolution: data.resolution,
        },
      }
    );

    // Fetch updated dispute with relations
    const updatedDispute: any = await strapi.entityService.findOne(
      "api::dispute.dispute",
      data.disputeId,
      {
        populate: {
          order: true,
          raisedBy: true,
          recievedBy: true,
        },
      }
    );
     
    // Create notification for dispute raiser
      // const userNotificationSetting = await strapi.config.index.findUserNotificationSettingByUserID(prodOwner)
        // const isCreateNotification =   userNotificationSetting?.notificationSettings?.order;
    if (updatedDispute?.raisedBy?.id) {
      await strapi.entityService.create(
        "api::notification.notification" as any,
        {
          data: {
            type: "dispute_raised",
            title: "Dispute Status Updated",
            body: `The status of your dispute regarding order #${updatedDispute?.order?.id} has been updated to ${data.status}.`,
            read: false,
            link: "/Orders?tab=Disputes_Raised",
            recipient: updatedDispute?.raisedBy?.id,
          },
        }
      );
    }

    return ctx.send({
      success: true,
      message: "Dispute status updated successfully.",
      data: updatedDispute,
    });
  } catch (error) {
    console.error("Error updating dispute status:", error);

    return ctx.internalServerError(
      "An error occurred while updating the dispute status."
    );
  }
}
  }),
);
