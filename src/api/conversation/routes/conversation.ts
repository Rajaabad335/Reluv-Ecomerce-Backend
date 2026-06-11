export default {
  routes: [
    {
      method: 'GET',
      path: '/conversations/unread-count',
      handler: 'conversation.getUnreadCount',
      config: {
        auth: {},
      },
    },
    {
      method: 'GET',
      path: '/conversations/my',
      handler: 'conversation.listMine',
      config: {
        auth: {},
      },
    },
    {
      method: 'POST',
      path: '/conversations/for-product',
      handler: 'conversation.createForProduct',
      config: {
        auth: {},
      },
    },
  ],
};
