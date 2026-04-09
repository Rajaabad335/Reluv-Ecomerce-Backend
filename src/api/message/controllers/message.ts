/**
 * message controller
 */

import { factories } from '@strapi/strapi';

const conversationUid = 'api::conversation.conversation' as any;
const messageUid = 'api::message.message' as any;

const getUserIdFromCtx = (ctx: any): number | null => {
  const userId = ctx?.state?.user?.id;
  if (!Number.isInteger(userId) || userId <= 0) return null;
  return Number(userId);
};

const sanitizeMessage = (message: any) => ({
  id: message?.id,
  content: message?.content ?? '',
  createdAt: message?.createdAt ?? null,
  sender: message?.sender
    ? { id: message.sender.id, username: message.sender.username, avatar: message.sender.avatar ?? null }
    : null,
});

const assertParticipant = async (strapi: any, conversationId: number, userId: number): Promise<boolean> => {
  const rows = await strapi.entityService.findMany(conversationUid, {
    filters: {
      id: { $eq: conversationId },
      $or: [{ buyer: { id: { $eq: userId } } }, { seller: { id: { $eq: userId } } }],
    },
    fields: ['id'],
    limit: 1,
  }) as any[];
  return Boolean(rows?.[0]);
};

export default factories.createCoreController(messageUid, ({ strapi }) => ({
  async listByConversation(ctx: any) {
    try {
      const userId = getUserIdFromCtx(ctx);
      if (!userId) return ctx.unauthorized('Authentication required.');

      const conversationId = Number(ctx.params?.id);
      if (!Number.isInteger(conversationId) || conversationId <= 0) {
        return ctx.badRequest('Conversation id is required.');
      }

      const canAccess = await assertParticipant(strapi, conversationId, userId);
      if (!canAccess) return ctx.unauthorized('Not allowed.');

      const messages = await strapi.entityService.findMany(messageUid, {
        filters: { conversation: { id: { $eq: conversationId } } },
        populate: { sender: { fields: ['id', 'username'], populate: { avatar: { fields: ['url'] } } } },
        sort: { createdAt: 'asc' },
        limit: 2000,
      }) as any[];

      ctx.body = {
        ok: true,
        messages: messages.map(sanitizeMessage),
      };
    } catch (error) {
      strapi.log.error(error);
      return ctx.internalServerError('Failed to load messages.');
    }
  },
  async sendMessage(ctx: any) {
    try {
      const userId = getUserIdFromCtx(ctx);
      if (!userId) return ctx.unauthorized('Authentication required.');

      const conversationId = Number(ctx.request?.body?.conversationId);
      const content = String(ctx.request?.body?.content ?? '').trim();

      if (!Number.isInteger(conversationId) || conversationId <= 0) {
        return ctx.badRequest('conversationId is required.');
      }
      if (!content) return ctx.badRequest('content is required.');

      const canAccess = await assertParticipant(strapi, conversationId, userId);
      if (!canAccess) return ctx.unauthorized('Not allowed.');

      const created = await strapi.entityService.create(messageUid, {
        data: {
          conversation: conversationId,
          sender: userId,
          content,
        },
        populate: { sender: { fields: ['id', 'username'], populate: { avatar: { fields: ['url'] } } } },
      });

      await strapi.entityService.update(conversationUid, conversationId, {
        data: {
          lastMessageAt: new Date().toISOString(),
          lastMessagePreview: content.slice(0, 120),
        },
      });

      const io = (strapi as any).io as import('socket.io').Server | undefined;
      if (io) {
        io.to(`conversation:${conversationId}`).emit('message:new', {
          conversationId,
          id: created.id,
          content: created.content,
          createdAt: created.createdAt,
          sender: created.sender
            ? { id: created.sender.id, username: created.sender.username, avatar: created.sender.avatar ?? null }
            : null,
        });
      }

      ctx.body = {
        ok: true,
        message: sanitizeMessage(created),
      };
    } catch (error) {
      strapi.log.error(error);
      return ctx.internalServerError('Failed to send message.');
    }
  },
}));
