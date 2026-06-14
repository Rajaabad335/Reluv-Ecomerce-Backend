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
}
};
