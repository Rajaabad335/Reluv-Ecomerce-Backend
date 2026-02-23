export default {
  routes: [
    {
      method: 'POST',
      path: '/products/sell-now',
      handler: 'product.createSellNow',
      config: {
        auth: false,
      },
    },
  ],
};
