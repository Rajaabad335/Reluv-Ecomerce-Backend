export default {
  routes: [
    {
      method: "POST",
      path: "/auth/line",
      handler: "line-auth.login",
      config: { auth: false },
    },
  ],
};
