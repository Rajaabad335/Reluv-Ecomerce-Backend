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
    {
      method: 'GET',
      path: '/products/getProducts',
      handler: 'product.getProducts',
      config: {
        auth: false,
      },
    },
    {
      method: 'GET',
      path: '/products/getProductById/:id',
      handler: 'product.getProductById',
      config: {
        auth: false,
      },
    }
  ],
};
