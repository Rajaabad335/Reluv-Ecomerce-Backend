export default {
  routes: [
    { method: "GET", path: "/listing-verifications", handler: "listing-verification.find", config: { policies: ["global::is-marketplace-admin"] } },
    { method: "GET", path: "/listing-verifications/:id", handler: "listing-verification.findOne", config: { policies: ["global::is-marketplace-admin"] } },
    { method: "POST", path: "/listing-verifications/:id/decision", handler: "listing-verification.decision", config: { policies: ["global::is-marketplace-admin"] } },
    { method: "POST", path: "/listing-verifications/evidence", handler: "listing-verification.submitEvidence", config: { policies: [] } },
    { method: "GET", path: "/listing-verifications/mine/:productId", handler: "listing-verification.mine", config: { policies: [] } },
  ],
};
