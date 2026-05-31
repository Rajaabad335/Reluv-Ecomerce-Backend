/**
 * dispute controller
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreController('api::dispute.dispute', ({ strapi }) => ({
async fileDispute(ctx) {
  try {
    const { body } = ctx.request;

    // Validate required fields
    if (!body.order || !body.raisedBy || !body.reason) {
      return ctx.badRequest("Missing required fields: order, raisedBy, reason");
    }

    // Check for existing dispute
    const disputeExisting = await strapi.entityService.findMany(
      "api::dispute.dispute",
      {
        filters: { 
          order:  body.order,
          recievedBy: { id: body.sellerId },  // ✅ must be object with id
          raisedBy: { id: body.raisedBy },      // ✅ must be object with id
        } as any,
      }
    );

    if (disputeExisting.length > 0) {
      return ctx.badRequest(
        "Dispute already exists for this order from same buyer"
      );
    }

    // Create the dispute
    const newDispute = await strapi.entityService.create("api::dispute.dispute", {
      data: {
        order: body.order,           // ✅ scalar ID works for create
        recievedBy: body.sellerId,   // ✅ scalar ID works for create
        raisedBy: body.raisedBy,      // ✅ scalar ID works for create
        reason: body.reason,         // ✅ required enum field
        description: body.details ?? null,
        status: "OPEN",              // ✅ explicit default (matches schema)
      } as any,
    });
    if(newDispute) {
          // Notify seller
      await strapi.entityService.create(
        "api::notification.notification" as any,
        {
          data: {
            type: "dispute_received",
            title: "New dispute Received",
            body: `You received a dispute of ${newDispute?.reason} on "${(body?.order as any)}".`,
            read: false,
            link: `/Orders?tab=Disputes_Recieved`,
            recipient: body.sellerId,
          },
        }
      );
    }
    return ctx.created(newDispute);

  } catch (error) {
    console.error("Error filing dispute:", error);
    return ctx.internalServerError(
      "An error occurred while filing the dispute."
    );
  }
},
}));
