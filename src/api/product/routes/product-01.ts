export default {
  routes: [
    {
      method: "POST",
      path: "/products/sell-now",
      handler: "product.createSellNow",
      config: {
        auth: false,
      },
    },
    {
      method: "GET",
      path: "/products/getProducts",
      handler: "product.getProducts",
      config: {
        auth: false,
      },
    },
    {
      method: "GET",
      path: "/products/getProductById/:id",
      handler: "product.getProductById",
      config: {
        auth: false,
      },
    },
    {
      method: "GET",
      path: "/products/filter",
      handler: "product.filterProducts",
      config: {
        auth: false,
      },
    },
    {
      method: "GET",
      path: "/products/search",
      handler: "product.searchProducts",
      config: {
        auth: false,
      },
    },
    {
      method: "GET",
      path: "/products/filter-options",
      handler: "product.getFilterOptions",
      config: {
        auth: false,
      },
    },
    {
      method: "GET",
      path: "/dashboard-data",
      handler: "product.getDashboardData",
      config: {
        auth: false,
      },
    },
    {
      method: "GET",
      path: "/all-users",
      handler: "product.getAllUsers",
    },
    {
      method: "GET",
      path: "/products/user/:userId",
      handler: "product.getProductsByUserId",
    },
  ],
};
