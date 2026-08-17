export default {
  routes: [
    { method: "POST", path: "/listing-ai/analyze", handler: "listing-ai.analyze", config: { policies: [], middlewares: [] } },
    { method: "POST", path: "/listing-ai/rescope", handler: "listing-ai.rescope", config: { policies: [], middlewares: [] } },
    { method: "POST", path: "/listing-ai/feedback", handler: "listing-ai.feedback", config: { policies: [], middlewares: [] } },
  ],
};
