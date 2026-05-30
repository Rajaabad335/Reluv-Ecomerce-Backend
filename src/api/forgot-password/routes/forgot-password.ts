export default {
  routes: [
    {
      method: "POST",
      path: "/password-reset/send-otp",
      handler: "forgot-password.sendOtp",
      config: { auth: false },
    },
    {
      method: "POST",
      path: "/password-reset/verify-otp",
      handler: "forgot-password.verifyOtp",
      config: { auth: false },
    },
    {
      method: "POST",
      path: "/password-reset/reset",
      handler: "forgot-password.resetPassword",
      config: { auth: false },
    },
    {
      method: "POST",
      path: "/email-change/send-otp",
      handler: "forgot-password.sendEmailChangeOtp",
      config: { auth: false },
    },
    {
      method: "POST",
      path: "/email-change/verify-otp",
      handler: "forgot-password.verifyEmailChangeOtp",
      config: { auth: false },
    },
    {
      method: "POST",
      path: "/email-change/confirm",
      handler: "forgot-password.confirmNewEmail",
      config: { auth: false },
    },
  ],
};
