export default {
  async findManyWithBatches(data) {
    const batchSize = 10000;
    let resultData: any[] = [];
    let ids = data.ids;
    if (ids.length > 0) {
      for (let i = 0; i < ids.length; i += batchSize) {
        const batch = ids.slice(i, i + batchSize);

        const batchResult = await strapi.entityService.findMany(data.uid, {
          filters: {
            id: {
              $in: batch,
            },
          },
          populate: data.populateString ? data.populateString : ["*"],
        });

        resultData.push(
          ...(Array.isArray(batchResult) ? batchResult : [batchResult]),
        );
      }
    }
    return resultData;
  },
  async findUserNotificationSettingByUserID(ID: number) {
    const user = await strapi.entityService.findOne(
      "plugin::users-permissions.user",
      ID
    );
    return user?.notificationSettings ?? null;
  },
  async  createOrGetConversation(
  sellerId: number,
  buyerId: number,
  productId: number
) {
  const existing = (await strapi.entityService.findMany("api::conversation.conversation", {
    filters: {
      product: { id: { $eq: productId } },
      buyer: { id: { $eq: buyerId } },
      seller: { id: { $eq: sellerId } },
    },
    populate: {
      product: {
        fields: ["id", "title", "price"],
        populate: { images: { fields: ["url"] } },
      },
      buyer: {
        fields: ["id", "username"],
        populate: { avatar: { fields: ["url"] } },
      },
      seller: {
        fields: ["id", "username"],
        populate: { avatar: { fields: ["url"] } },
      },
    },
    limit: 1,
  })) as any[];
  if (existing?.[0]) {
    return {
      created: false,
      conversation: existing[0],
    };
  }

  const created = await strapi.entityService.create("api::conversation.conversation", {
    data: {
      product: productId,
      buyer: buyerId,
      seller: sellerId,
      lastMessageAt: new Date().toISOString(),
      lastMessagePreview: "",
    },
    populate: {
      product: {
        fields: ["id", "title", "price"],
        populate: { images: { fields: ["url"] } },
      },
      buyer: {
        fields: ["id", "username"],
        populate: { avatar: { fields: ["url"] } },
      },
      seller: {
        fields: ["id", "username"],
        populate: { avatar: { fields: ["url"] } },
      },
    },
  });
  return {
    created: true,
    conversation: created,
  };
},
// ── Helper ──────────────────────────────────────────────────────────────
 buildNotificationDescription(
  type: string,
  name: string,
  fallback?: string
): string {
  switch (type) {
    case "welcome":                  return `${name} just joined the platform.`;
    case "login":                    return `${name} logged in to their account.`;
    case "product_created":          return `${name} listed a new product.`;
    case "order":                    return `${name} placed a new order.`;
    case "new_message":              return `${name} sent a new message.`;
    case "new_follower":             return `${name} started following a user.`;
    case "order_update":             return `Order status updated for ${name}.`;
    case "review":                   return `${name} left a review.`;
    case "add_fav_list":             return `${name} added an item to favourites.`;
    case "offer_received":           return `${name} received a new offer.`;
    case "offer_accepted":           return `${name}'s offer was accepted.`;
    case "offer_declined":           return `${name}'s offer was declined.`;
    case "dispute_received":         return `${name} received a dispute.`;
    case "dispute_raised":           return `${name} raised a dispute.`;
    case "dispute_status_updated":   return `Dispute status updated for ${name}.`;
    case "dispute_resolved":         return `Dispute resolved for ${name}.`;
    case "refund_processed":         return `A refund was processed for ${name}.`;
    default:                         return fallback ?? `New notification for ${name}.`;
  }
}
};
