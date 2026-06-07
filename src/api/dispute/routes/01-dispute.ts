export default {
  routes: [
    {
      method: "POST",
      path: "/disputes/file-dispute",
      handler: "dispute.fileDispute",
      config: {
        auth: false,
      }
    },
    {
      method: "POST",
      path: "/disputes/update-dispute-status",
      handler: "dispute.UpdateDisputeStatus",
      config: {
        auth: false,
      }
    }
  ],
};