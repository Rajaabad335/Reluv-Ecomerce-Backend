export default {
  routes: [
    {
      method: 'GET',
      path: '/conversations/unread-count',
      handler: 'conversation.getUnreadCount',
      config: { auth: false, policies: [], middlewares: [] },
    },
    {
      method: 'GET',
      path: '/conversations/my',
      handler: 'conversation.listMine',
      config: { auth: false, policies: [], middlewares: [] },
    },
    {
      method: 'POST',
      path: '/conversations/for-product',
      handler: 'conversation.createForProduct',
      config: { auth: false, policies: [], middlewares: [] },
    },
  ],
};
