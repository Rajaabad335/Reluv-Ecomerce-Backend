export default {
  routes: [
    {
      method: "POST",
      path: "/stripe-connect/onboard",
      handler: "payout.onboardStripeConnect",
      config: { auth: false },
    },
    {
      method: "GET",
      path: "/stripe-connect/status",
      handler: "payout.getStripeConnectStatus",
      config: { auth: false },
    },
  ],
};
