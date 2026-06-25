/**
 * conversation controller
 */

import { factories } from "@strapi/strapi";

const conversationUid = "api::conversation.conversation" as any;
const productUid = "api::product.product" as any;

const getDeletedAtForUser = (
  conversation: any,
  userId: number,
): string | null => {
  if (conversation?.buyer?.id === userId) {
    return conversation?.buyerDeletedAt ?? null;
  }
  if (conversation?.seller?.id === userId) {
    return conversation?.sellerDeletedAt ?? null;
  }
  return null;
};

const isConversationVisibleToUser = (
  conversation: any,
  userId: number,
): boolean => {
  const deletedAt = getDeletedAtForUser(conversation, userId);
  if (!deletedAt) return true;
  if (!conversation?.lastMessageAt) return false;
  return new Date(conversation.lastMessageAt).getTime() >
    new Date(deletedAt).getTime();
};

const permanentlyDeleteConversation = async (
  strapi: any,
  conversationId: number,
) => {
  const messages = await strapi.db.query("api::message.message").findMany({
    where: { conversation: { id: conversationId } },
    populate: ["attachments"],
  });

  for (const message of messages) {
    for (const file of message.attachments ?? []) {
      try {
        await strapi.plugins.upload.services.upload.remove({ id: file.id });
      } catch (err: any) {
        strapi.log.warn(`Failed to delete file ${file.id}:`, err.message);
      }
    }
  }

  await strapi.db.query("api::message.message").deleteMany({
    where: { conversation: { id: conversationId } },
  });

  await strapi.db.query("api::conversation.conversation").delete({
    where: { id: conversationId },
  });
};

const getUserIdFromCtx = async (
  strapi: any,
  ctx: any,
): Promise<number | null> => {
  const userId = ctx?.state?.user?.id;
  if (Number.isInteger(userId) && userId > 0) return Number(userId);
  const authHeader = String(ctx.request.headers?.authorization ?? "");
  if (!authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7).trim();
  if (!token) return null;
  try {
    const payload = await strapi
      .plugin("users-permissions")
      .service("jwt")
      .verify(token);
    return payload?.id ? Number(payload.id) : null;
  } catch {
    return null;
  }
};

const sanitizeConversation = (
  conversation: any,
  hasUnread: boolean = false,
) => ({
  id: conversation?.id,
  product: conversation?.product
    ? {
        id: conversation.product.id,
        title: conversation.product.title,
        price: conversation.product.price,
        images: conversation.product.images ?? [],
      }
    : null,
  buyer: conversation?.buyer
    ? {
        id: conversation.buyer.id,
        username: conversation.buyer.username,
        avatar: conversation.buyer.avatar ?? null,
      }
    : null,
  seller: conversation?.seller
    ? {
        id: conversation.seller.id,
        username: conversation.seller.username,
        avatar: conversation.seller.avatar ?? null,
      }
    : null,
  lastMessagePreview: conversation?.lastMessagePreview ?? null,
  lastMessageAt: conversation?.lastMessageAt ?? null,
  updatedAt: conversation?.updatedAt ?? null,
  hasUnread,
});

export default factories.createCoreController(
  "api::conversation.conversation",
  ({ strapi }) => ({
    async getUnreadCount(ctx: any) {
      try {
        const userId = await getUserIdFromCtx(strapi, ctx);
        if (!userId) return ctx.unauthorized("Authentication required.");

        const messageUid = "api::message.message" as any;

        const conversations = (await strapi.entityService.findMany(
          conversationUid,
          {
            filters: {
              $or: [
                { buyer: { id: { $eq: userId } } },
                { seller: { id: { $eq: userId } } },
              ],
            },
            populate: {
              buyer: { fields: ["id"] },
              seller: { fields: ["id"] },
            },
            fields: [
              "id",
              "lastMessageAt",
              "buyerDeletedAt",
              "sellerDeletedAt",
            ],
            limit: 200,
          },
        )) as any[];

        let unreadConversationCount = 0;

        for (const conv of conversations) {
          if (!isConversationVisibleToUser(conv, userId)) continue;

          const otherUserId =
            conv.buyer?.id === userId ? conv.seller?.id : conv.buyer?.id;
          if (!otherUserId) continue;
          const deletedAt = getDeletedAtForUser(conv, userId);

          const unreadMessages = (await strapi.entityService.findMany(
            messageUid,
            {
              filters: {
                conversation: { id: { $eq: conv.id } },
                sender: { id: { $eq: otherUserId } },
                readAt: { $null: true },
                ...(deletedAt
                  ? { createdAt: { $gt: deletedAt } }
                  : {}),
              },
              fields: ["id"],
              limit: 1, // ← we only need to know if ANY exist
            },
          )) as any[];

          if (unreadMessages.length > 0) {
            unreadConversationCount++;
          }
        }

        ctx.body = {
          ok: true,
          unreadConversationCount, // ← this is what you show on the icon
        };
      } catch (error) {
        strapi.log.error(error);
        return ctx.internalServerError("Failed to get unread count.");
      }
    },

    async listMine(ctx: any) {
      try {
        const userId = await getUserIdFromCtx(strapi, ctx);
        if (!userId) return ctx.unauthorized("Authentication required.");

        const conversations = (await strapi.entityService.findMany(
          conversationUid,
          {
            filters: {
              $or: [
                { buyer: { id: { $eq: userId } } },
                { seller: { id: { $eq: userId } } },
              ],
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
            sort: { lastMessageAt: "desc" },
            limit: 200,
          },
        )) as any[];

        const messageUid = "api::message.message" as any;
        const conversationsWithUnread = await Promise.all(
          conversations
          .filter((conv) => isConversationVisibleToUser(conv, userId))
          .map(async (conv) => {
            const otherUserId =
              conv.buyer?.id === userId ? conv.seller?.id : conv.buyer?.id;
            if (!otherUserId) return sanitizeConversation(conv, false);
            const deletedAt = getDeletedAtForUser(conv, userId);

            const unreadMessages = (await strapi.entityService.findMany(
              messageUid,
              {
                filters: {
                  conversation: { id: { $eq: conv.id } },
                  sender: { id: { $eq: otherUserId } },
                  readAt: { $null: true },
                  ...(deletedAt
                    ? { createdAt: { $gt: deletedAt } }
                    : {}),
                },
                fields: ["id"],
                limit: 1,
              },
            )) as any[];

            return sanitizeConversation(conv, unreadMessages.length > 0);
          }),
        );

        ctx.body = {
          ok: true,
          conversations: conversationsWithUnread,
        };
      } catch (error) {
        strapi.log.error(error);
        return ctx.internalServerError("Failed to load conversations.");
      }
    },

    async createForProduct(ctx: any) {
      try {
        const userId = await getUserIdFromCtx(strapi, ctx);
        if (!userId) return ctx.unauthorized("Authentication required.");

        const productId = Number(ctx.request?.body?.productId);
        const otherUserId = ctx.request?.body?.otherUserId
          ? Number(ctx.request.body.otherUserId)
          : null;
        if (!Number.isInteger(productId) || productId <= 0) {
          return ctx.badRequest("productId is required.");
        }

        const productRows = (await strapi.entityService.findMany(productUid, {
          filters: { id: { $eq: productId } },
          fields: ["id"],
          populate: { users_permissions_user: { fields: ["id"] } },
          limit: 1,
        })) as any[];

        const product = productRows?.[0];
        if (!product) return ctx.notFound("Product not found.");

        const sellerId = Number(product?.users_permissions_user?.id);
        if (!Number.isInteger(sellerId) || sellerId <= 0) {
          return ctx.badRequest("Seller not found for product.");
        }

        let buyerId = userId;
        if (userId === sellerId) {
          if (
            !otherUserId ||
            !Number.isInteger(otherUserId) ||
            otherUserId <= 0
          ) {
            return ctx.badRequest(
              "otherUserId is required when seller creates a conversation.",
            );
          }
          buyerId = otherUserId;
        }

        const existing = (await strapi.entityService.findMany(conversationUid, {
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
          ctx.body = {
            ok: true,
            conversation: sanitizeConversation(existing[0], false),
          };
          return;
        }

        const created = await strapi.entityService.create(conversationUid, {
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

        ctx.body = { ok: true, conversation: sanitizeConversation(created, false) };
      } catch (error) {
        strapi.log.error(error);
        return ctx.internalServerError("Failed to create conversation.");
      }
    },
    async deleteConversation(ctx: any) {
      const conversationId = Number(ctx.params?.id);
      const userId = Number(ctx.state.user?.id);

      if (!userId) return ctx.unauthorized("You must be logged in.");
      if (!Number.isInteger(conversationId) || conversationId <= 0) {
        return ctx.badRequest("A valid conversation id is required.");
      }

      const conversation = await strapi.db
        .query("api::conversation.conversation")
        .findOne({
          where: { id: conversationId },
          populate: ["buyer", "seller"],
        });

      if (!conversation) return ctx.notFound("Conversation not found.");

      const isBuyer = conversation.buyer?.id === userId;
      const isSeller = conversation.seller?.id === userId;

      if (!isBuyer && !isSeller) {
        return ctx.forbidden("You are not part of this conversation.");
      }

      const deletionField = isBuyer ? "buyerDeletedAt" : "sellerDeletedAt";
      const otherDeletionField = isBuyer
        ? "sellerDeletedAt"
        : "buyerDeletedAt";

      if (conversation[otherDeletionField]) {
        await permanentlyDeleteConversation(strapi, conversationId);
        return ctx.send({
          message: "Conversation permanently deleted.",
          permanentlyDeleted: true,
        });
      }

      await strapi.db.query("api::conversation.conversation").update({
        where: { id: conversationId },
        data: { [deletionField]: new Date().toISOString() },
      });

      return ctx.send({
        message: "Conversation deleted for you.",
        permanentlyDeleted: false,
      });
    },
  }),
);
