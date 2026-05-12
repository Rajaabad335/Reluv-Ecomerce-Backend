export default {
  routes: [
    {
      method: "POST",
      path: "/offers/make",
      handler: "offer.makeOffer",
      config: { auth: false },
    },
    {
      method: "GET",
      path: "/offers/seller/:sellerId",
      handler: "offer.getOffersForSeller",
      config: { auth: false },
    },
    {
      method: "GET",
      path: "/offers/buyer/:buyerId",
      handler: "offer.getOffersForBuyer",
      config: { auth: false },
    },
    {
      method: "PATCH",
      path: "/offers/:id/respond",
      handler: "offer.respondToOffer",
      config: { auth: false },
    },
    {
      method: "POST",
      path: "/offers/:id/complete",
      handler: "offer.completeOffer",
      config: { auth: false },
    },
    {
      method: "GET",
      path: "/offers/check-expiry",
      handler: "offer.checkExpiredOffers",
      config: { auth: false },
    },
  ],
};
