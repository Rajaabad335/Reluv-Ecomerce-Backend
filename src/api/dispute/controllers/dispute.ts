/**
 * dispute controller
 */

import { factories } from "@strapi/strapi";
import order from "../../order/services/order";

export default factories.createCoreController(
  "api::dispute.dispute",
  ({ strapi }) => ({
    async fileDispute(ctx) {
      try {
        const { data } = ctx.request.body;
        // Check for existing dispute
        const disputeExisting = await strapi.entityService.findMany(
          "api::dispute.dispute",
          {
            filters: {
              order: { id: data.order },
              recievedBy: { id: data.sellerId },
              raisedBy: { id: data.raisedBy },
            } as any,
          },
        );

        if (disputeExisting.length > 0) {
          return ctx.badRequest(
            "Dispute already exists for this order from same buyer",
          );
        }
        // Create the dispute
        const newDispute = await strapi.entityService.create(
          "api::dispute.dispute",
          {
            data: {
              order: { id: data.order },
              recievedBy: { id: data.sellerId },
              raisedBy: { id: data.raisedBy },
              reason: data.reason,
              description: data.details ?? null,
              status: "OPEN",
            } as any,
          },
        );
        if (newDispute) {
          // Fetch order details for notification
          const orderDetails = await strapi.entityService.findOne(
            "api::order.order",
            data.order,
            { fields: ["id"] }, // adjust field name to match your Order schema
          );
          // Notify seller
          await strapi.entityService.create(
            "api::notification.notification" as any,
            {
              data: {
                type: "dispute_received",
                title: "New Dispute Received",
                body: `You received a dispute of ${newDispute.reason} on order #${orderDetails?.id ?? data.order}.`,
                read: false,
                link: `/Orders?tab=Disputes_Recieved`,
                recipient: data.sellerId,
              },
            },
          );
        }

        return ctx.created(newDispute);
      } catch (error) {
        console.error("Error filing dispute:", error);
        return ctx.internalServerError(
          "An error occurred while filing the dispute.",
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
