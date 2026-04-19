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
  },
  async getAllOrders(ctx: any) {
  try {
    const allOrders = await strapi.entityService.findMany("api::order.order", {
      populate: {
        buyer: true,
        seller: true,
        product: true,
      },
      sort: { createdAt: "desc" },
    });

    // ✅ Transform data to match frontend UI
    const formattedOrders = allOrders.map((order: any) => ({
      id: order.id,

      buyer: {
        name: order.buyer?.username || "N/A",
        avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=${order.buyer?.username || "user"}`
      },

      seller: {
        name: order.seller?.username || "N/A",
        avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=${order.seller?.username || "seller"}`
      },

      amount: order.totalAmount
        ? `€${order.totalAmount}`
        : "€0.00",

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
}

}));
