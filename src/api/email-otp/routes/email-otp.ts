export default {
  routes: [
    {
      method: "POST",
      path: "/email-otp/send",
      handler: "email-otp.send",
      config: { auth: false },
    },
    {
      method: "POST",
      path: "/email-otp/verify",
      handler: "email-otp.verify",
      config: { auth: false },
    },
  ],
};
