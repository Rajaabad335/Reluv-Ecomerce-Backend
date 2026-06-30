export default {
  routes: [
    {
      method: "POST",
      path: "/orders/place-order",
      handler: "order.placeOrder",
      config: {
        auth: false,
      },
    },
    {   method: "POST",
      path: "/orders/fetch-orders-by-user",
      handler: "order.fetchOrdersByUser",
      config: {
        auth: false,
      },
    },
    {
      method: "GET",
      path: "/orders/get-all-orders",
      handler: "order.getAllOrders",
       config: {
        auth: false,
      },
    },
    {
      method: "PUT",
      path: "/orders/:id/update-status",
      handler: "order.updateStatus",
      config: {
        auth: false,
      },
    },
    {
      method: "DELETE",
      path: "/orders/:id/delete",
      handler: "order.deleteOrder",
      config: {
        auth: false,
      },
    },
    
  ],
};
