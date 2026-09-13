export default {
  routes: [
    {
      method: "GET",
      path: "/marketplace-settings/current",
      handler: "marketplace-setting.current",
      config: {
        auth: false,
        policies: [], // make sure nothing here blocks public
      },
    },
  ],
};
