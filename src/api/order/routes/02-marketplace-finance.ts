export default {
  routes: [
    {
      method: "GET",
      path: "/orders/:id/payment-summary",
      handler: "order.getPaymentSummary",
      config: {
        auth: false,
      },
    },
    {
      method: "POST",
      path: "/orders/:id/confirm-delivery",
      handler: "order.confirmDelivery",
      config: {
        auth: false,
      },
    },
    {
      method: "GET",
      path: "/orders/:id/dispute-eligibility",
      handler: "order.getDisputeEligibility",
      config: {
        auth: false,
      },
    },
    {
      method: "POST",
      path: "/orders/:id/disputes",
      handler: "order.createOrderDispute",
      config: {
        auth: false,
      },
    },
    {
      method: "POST",
      path: "/orders/:id/refund-requests",
      handler: "order.createRefundRequest",
      config: {
        auth: false,
      },
    },
    {
      method: "GET",
      path: "/orders/:id/disputes",
      handler: "order.getOrderDisputes",
      config: {
        auth: false,
      },
    },
  ],
};

