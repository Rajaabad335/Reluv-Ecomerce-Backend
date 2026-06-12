export default {
  routes: [
    {
      method: "GET",
      path: "/notifications/my",
      handler: "notification.getMine",
      config: { auth: false, middlewares: [], policies: [] },
    },
    {
      method: "PATCH",
      path: "/notifications/:id/read",
      handler: "notification.markRead",
      config: { auth: false, middlewares: [], policies: [] },
    },
    {
      method: "PATCH",
      path: "/notifications/read-all",
      handler: "notification.markAllRead",
      config: { auth: false, middlewares: [], policies: [] },
    },
  ],
};
