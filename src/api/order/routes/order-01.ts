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
  ],
};
