export default {
  routes: [
    // Standardized RESTful APIs (Section 10)
    {
      method: "GET",
      path: "/admin/disputes",
      handler: "payout.getAdminDisputes",
      config: { auth: false },
    },
    {
      method: "GET",
      path: "/admin/disputes/:id",
      handler: "payout.getAdminDisputeById",
      config: { auth: false },
    },
    {
      method: "PATCH",
      path: "/admin/disputes/:id/status",
      handler: "payout.updateAdminDisputeStatus",
      config: { auth: false },
    },
    {
      method: "POST",
      path: "/admin/disputes/:id/refund",
      handler: "payout.adminRefundBuyer",
      config: { auth: false },
    },
    {
      method: "POST",
      path: "/admin/disputes/:id/release",
      handler: "payout.adminReleaseToSeller",
      config: { auth: false },
    },
    {
      method: "GET",
      path: "/admin/payouts",
      handler: "payout.getAdminPayouts",
      config: { auth: false },
    },
    {
      method: "GET",
      path: "/admin/payouts/:id",
      handler: "payout.getAdminPayoutById",
      config: { auth: false },
    },
    {
      method: "POST",
      path: "/admin/payouts/:id/release",
      handler: "payout.adminReleasePayout",
      config: { auth: false },
    },
    {
      method: "GET",
      path: "/admin/payouts/:id/history",
      handler: "payout.getAdminPayoutHistory",
      config: { auth: false },
    },

    // Stripe Webhook Endpoint (Section 8)
    {
      method: "POST",
      path: "/stripe/webhook",
      handler: "payout.handleStripeWebhook",
      config: { auth: false },
    },

    // Additional Financial APIs
    {
      method: "GET",
      path: "/admin/financial-summary",
      handler: "payout.getFinancialSummary",
      config: { auth: false },
    },
    {
      method: "GET",
      path: "/admin/payout-orders",
      handler: "payout.getPayoutOrders",
      config: { auth: false },
    },
    {
      method: "POST",
      path: "/admin/release-payout",
      handler: "payout.releasePayout",
      config: { auth: false },
    },
    {
      method: "POST",
      path: "/admin/dispute-action",
      handler: "payout.handleDisputeAction",
      config: { auth: false },
    },
    {
      method: "GET",
      path: "/admin/disputes-full",
      handler: "payout.getDisputesFull",
      config: { auth: false },
    },
    {
      method: "GET",
      path: "/admin/refunds",
      handler: "payout.getRefunds",
      config: { auth: false },
    },
    {
      method: "GET",
      path: "/admin/transactions",
      handler: "payout.getTransactions",
      config: { auth: false },
    },
    {
      method: "GET",
      path: "/admin/seller-payout-profiles",
      handler: "payout.getSellerPayoutProfiles",
      config: { auth: false },
    },
  ],
};
