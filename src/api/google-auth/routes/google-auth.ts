export default {
  routes: [
    {
      method: 'POST',
      path: '/auth/google',
      handler: 'google-auth.login',
      config: {
        auth: false,
      },
    },
  ],
};
