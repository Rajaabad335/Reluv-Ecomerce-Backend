export default {
  routes: [
    {
      method: "GET",
      path: "/notifications/my",
      handler: "notification.getMine",
      config: { middlewares: [], policies: [] },
    },
    {
      method: "PATCH",
      path: "/notifications/:id/read",
      handler: "notification.markRead",
      config: { middlewares: [], policies: [] },
    },
    {
      method: "PATCH",
      path: "/notifications/read-all",
      handler: "notification.markAllRead",
      config: { middlewares: [], policies: [] },
    },
  ],
};
