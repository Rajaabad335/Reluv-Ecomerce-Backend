/**
 * order controller
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreController('api::order.order', ({ strapi }) => ({
  async placeOrder(ctx) {
    try {
      const { body } = ctx.request as any; // Type assertion to access body
      console.log("Received order data:", body); // Debugging line

    //   // Validate required fields
    //   const requiredFields = ['title', 'brand', 'size', 'price', 'currency', 'imageUrl', 'buyerProtectionFee', 'shippingFee'];
    //   for (const field of requiredFields) {
    //     if (!body[field]) {
    //       return ctx.badRequest(`Missing required field: ${field}`);
    //     }
    //   }

      // Create the order using Strapi's entity service
      const newOrder = await strapi.entityService.create('api::order.order', {
        data: {
          product: body.productId || null,
          productTitle: body.title,
        //   brand: body.brand,
        //   size: body.size,
          productPrice: body.price,
        //   currency: body.currency,
          productImage: body.imageUrl,
          buyerProtectionFee: body.buyerProtectionFee,
          shippingFee: body.shippingFee,
          totalAmount: body.total,
          seller: Number(body.sellerId) || null,
          buyer: body.buyerId || null,
          phoneNumber: body.phoneNumber || null,
          address: body.address || null,
          deliveryMethod: body.deliveryMethod || null,
          orderStatus: body.OrderStatus,
          paymentStatus: "paid"
        },
      });

      console.log("Order created successfully:", newOrder); // Debugging line
      return ctx.created(newOrder);
    } catch (error) {
      console.error("Error placing order:", error); // Debugging line
      return ctx.internalServerError("An error occurred while placing the order.");
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

      const boughtOrders = await strapi.entityService.findMany('api::order.order', {
        filters: {
          buyer:{ id: Number(body.userId)}
        },
        populate: "*"
      });
       const  soldOrders = await strapi.entityService.findMany('api::order.order', {
        filters: {
          seller:{ id: Number(body.userId) }
        },
        populate: "*"
      });
      const ALLOrders = [];
      boughtOrders?.forEach((order: any) => {
        order.type = "Bought";
        ALLOrders.push(order);
      })
       soldOrders?.forEach((order: any) => {
        order.type = "Sold";
        ALLOrders.push(order);
      })
      return ctx.send({ data: ALLOrders });
    } catch (error) {
      console.error("Error fetching orders:", error); 
      return ctx.internalServerError("An error occurred while fetching the orders.");
    }
  }
}));
