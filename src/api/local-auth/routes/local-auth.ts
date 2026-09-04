export default {
  routes: [
    {
      method: 'POST',
      path: '/local-auth/login',
      handler: 'local-auth.login',
      config: { auth: false },
    },
    {
      method: 'POST',
      path: '/local-auth/debug-password',
      handler: 'local-auth.debugPassword',
      config: { auth: false },
    },
    {
      method: 'POST',
      path: '/local-auth/fix-password',
      handler: 'local-auth.fixPassword',
      config: { auth: false },
    },
  ],
};
