export default {
  routes: [

    /* ─────────────────────────────────────────────
       2-STEP VERIFICATION
    ───────────────────────────────────────────── */
    {
      method: "POST",
      path: "/two-factor/send-otp",
      handler: "security.sendTwoFaOtp",
      config: { auth: false },
    },
    {
      method: "POST",
      path: "/two-factor/toggle",
      handler: "security.toggleTwoFa",
      config: { auth: false },
    },

    /* ─────────────────────────────────────────────
       LOGIN ACTIVITY
    ───────────────────────────────────────────── */
    {
      method: "POST",
      path: "/login-activity/register",
      handler: "security.registerSession",
      config: { auth: false },
    },
    {
      method: "GET",
      path: "/login-activity/sessions",
      handler: "security.getSessions",
      config: { auth: false },
    },
    {
      method: "POST",
      path: "/login-activity/revoke",
      handler: "security.revokeSession",
      config: { auth: false },
    },
    {
      method: "POST",
      path: "/login-activity/revoke-all",
      handler: "security.revokeAllOtherSessions",
      config: { auth: false },
    },
    {
      method: "POST",
      path: "/login-activity/refresh",
      handler: "security.refreshSession",
      config: { auth: false },
    },
  ],
};