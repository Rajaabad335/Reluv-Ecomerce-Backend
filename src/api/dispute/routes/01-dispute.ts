export default {
  routes: [
    {
      method: "POST",
      path: "/disputes/file-dispute",
      handler: "dispute.fileDispute",
      config: {
        auth: false,
      }
    }
  ],
};