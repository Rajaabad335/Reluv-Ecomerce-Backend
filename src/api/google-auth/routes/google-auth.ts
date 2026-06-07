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
     {
      method: 'POST',
      path: '/auth/google/unlink',
      handler: 'google-auth.unlink',
      config: {
        auth: false, 
      },
    },
  ],
};
