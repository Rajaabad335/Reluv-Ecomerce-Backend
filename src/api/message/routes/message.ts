export default {
  routes: [
    {
      method: 'GET',
      path: '/messages/by-conversation/:id',
      handler: 'message.listByConversation',
      config: {
        auth: {},
      },
    },
    {
      method: 'POST',
      path: '/messages/send',
      handler: 'message.sendMessage',
      config: {
        auth: {},
      },
    },
  ],
};
