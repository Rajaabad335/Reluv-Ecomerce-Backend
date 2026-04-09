/**
 * conversation controller
 */

import { factories } from '@strapi/strapi';

const conversationUid = 'api::conversation.conversation' as any;
const productUid = 'api::product.product' as any;

const getUserIdFromCtx = (ctx: any): number | null => {
  const userId = ctx?.state?.user?.id;
  if (!Number.isInteger(userId) || userId <= 0) return null;
  return Number(userId);
};

const sanitizeConversation = (conversation: any) => ({
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
    ? { id: conversation.buyer.id, username: conversation.buyer.username, avatar: conversation.buyer.avatar ?? null }
    : null,
  seller: conversation?.seller
    ? { id: conversation.seller.id, username: conversation.seller.username, avatar: conversation.seller.avatar ?? null }
    : null,
  lastMessagePreview: conversation?.lastMessagePreview ?? null,
  lastMessageAt: conversation?.lastMessageAt ?? null,
  updatedAt: conversation?.updatedAt ?? null,
});

export default factories.createCoreController('api::conversation.conversation', ({ strapi }) => ({
  async listMine(ctx: any) {
    try {
      const userId = getUserIdFromCtx(ctx);
      if (!userId) return ctx.unauthorized('Authentication required.');

      const conversations = await strapi.entityService.findMany(conversationUid, {
        filters: {
          $or: [{ buyer: { id: { $eq: userId } } }, { seller: { id: { $eq: userId } } }],
        },
        populate: {
          product: { fields: ['id', 'title', 'price'], populate: { images: { fields: ['url'] } } },
          buyer: { fields: ['id', 'username'], populate: { avatar: { fields: ['url'] } } },
          seller: { fields: ['id', 'username'], populate: { avatar: { fields: ['url'] } } },
        },
        sort: { lastMessageAt: 'desc' },
        limit: 200,
      }) as any[];

      ctx.body = {
        ok: true,
        conversations: conversations.map(sanitizeConversation),
      };
    } catch (error) {
      strapi.log.error(error);
      return ctx.internalServerError('Failed to load conversations.');
    }
  },

  async createForProduct(ctx: any) {
    try {
      const userId = getUserIdFromCtx(ctx);
      if (!userId) return ctx.unauthorized('Authentication required.');

      const productId = Number(ctx.request?.body?.productId);
      const otherUserId = ctx.request?.body?.otherUserId ? Number(ctx.request.body.otherUserId) : null;
      if (!Number.isInteger(productId) || productId <= 0) {
        return ctx.badRequest('productId is required.');
      }

      const productRows = await strapi.entityService.findMany(productUid, {
        filters: { id: { $eq: productId } },
        fields: ['id'],
        populate: { users_permissions_user: { fields: ['id'] } },
        limit: 1,
      }) as any[];

      const product = productRows?.[0];
      if (!product) return ctx.notFound('Product not found.');

      const sellerId = Number(product?.users_permissions_user?.id);
      if (!Number.isInteger(sellerId) || sellerId <= 0) {
        return ctx.badRequest('Seller not found for product.');
      }

      let buyerId = userId;
      if (userId === sellerId) {
        if (!otherUserId || !Number.isInteger(otherUserId) || otherUserId <= 0) {
          return ctx.badRequest('otherUserId is required when seller creates a conversation.');
        }
        buyerId = otherUserId;
      }

      const existing = await strapi.entityService.findMany(conversationUid, {
        filters: {
          product: { id: { $eq: productId } },
          buyer: { id: { $eq: buyerId } },
          seller: { id: { $eq: sellerId } },
        },
        populate: {
          product: { fields: ['id', 'title', 'price'], populate: { images: { fields: ['url'] } } },
          buyer: { fields: ['id', 'username'], populate: { avatar: { fields: ['url'] } } },
          seller: { fields: ['id', 'username'], populate: { avatar: { fields: ['url'] } } },
        },
        limit: 1,
      }) as any[];

      if (existing?.[0]) {
        ctx.body = { ok: true, conversation: sanitizeConversation(existing[0]) };
        return;
      }

      const created = await strapi.entityService.create(conversationUid, {
        data: {
          product: productId,
          buyer: buyerId,
          seller: sellerId,
          lastMessageAt: new Date().toISOString(),
          lastMessagePreview: '',
        },
        populate: {
          product: { fields: ['id', 'title', 'price'], populate: { images: { fields: ['url'] } } },
          buyer: { fields: ['id', 'username'], populate: { avatar: { fields: ['url'] } } },
          seller: { fields: ['id', 'username'], populate: { avatar: { fields: ['url'] } } },
        },
      });

      ctx.body = { ok: true, conversation: sanitizeConversation(created) };
    } catch (error) {
      strapi.log.error(error);
      return ctx.internalServerError('Failed to create conversation.');
    }
  },
}));
