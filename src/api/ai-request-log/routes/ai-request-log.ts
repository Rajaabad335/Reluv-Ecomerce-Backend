export default {
  routes: [
    { method: "GET", path: "/ai-request-logs", handler: "ai-request-log.find", config: {} },
    { method: "GET", path: "/ai-request-logs/:id", handler: "ai-request-log.findOne", config: {} },
  ],
};
