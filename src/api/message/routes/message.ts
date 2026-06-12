export default {
  routes: [
    {
      method: 'GET',
      path: '/messages/by-conversation/:id',
      handler: 'message.listByConversation',
    },
    {
      method: 'POST',
      path: '/messages/send',
      handler: 'message.sendMessage',
    },
  ],
};
