/**
 * message controller
 */

import { factories } from '@strapi/strapi';
import { createNotification } from '../../../lib/createNotification';

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
  attachments: message?.attachments?.map((att: any) => ({
    id: att.id,
    url: att.url,
    name: att.name,
    ext: att.ext,
    mime: att.mime,
    size: att.size,
  })) ?? [],
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
        populate: ['sender', 'attachments'],
        sort: { createdAt: 'asc' },
        limit: 2000,
      }) as any[];

      // Mark all unread messages from others as read
      const unreadMessages = messages.filter(
        (msg) => msg.sender?.id !== userId && !msg.readAt
      );
      
      if (unreadMessages.length > 0) {
        await Promise.all(
          unreadMessages.map((msg) =>
            strapi.entityService.update(messageUid, msg.id, {
              data: { readAt: new Date().toISOString() },
            })
          )
        );

        // Emit socket event to update unread count
        const io = (strapi as any).io as import('socket.io').Server | undefined;
        if (io) {
          io.to(`conversation:${conversationId}`).emit('messages:read', {
            conversationId,
            readBy: userId,
          });
        }
      }

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
      const attachmentIds = ctx.request?.body?.attachments || [];

      if (!Number.isInteger(conversationId) || conversationId <= 0) {
        return ctx.badRequest('conversationId is required.');
      }
      if (!content && (!attachmentIds || attachmentIds.length === 0)) {
        return ctx.badRequest('content or attachments required.');
      }

      const canAccess = await assertParticipant(strapi, conversationId, userId);
      if (!canAccess) return ctx.unauthorized('Not allowed.');

      const messageData: any = {
        conversation: conversationId,
        sender: userId,
        content: content || '',
      };

      // Use entityService for creation to properly handle media relations
      const created = await strapi.entityService.create(messageUid, {
        data: {
          ...messageData,
          attachments: attachmentIds && attachmentIds.length > 0 ? attachmentIds : undefined,
        },
        populate: ['sender', 'attachments'],
      });

      strapi.log.info('Created message with attachments:', {
        messageId: created.id,
        attachmentIds,
        hasAttachments: !!created.attachments,
        attachmentsCount: created.attachments?.length || 0,
      });

      const preview = content || (attachmentIds.length > 0 ? `📎 ${attachmentIds.length} file(s)` : 'Message');
      await strapi.entityService.update(conversationUid, conversationId, {
        data: {
          lastMessageAt: new Date().toISOString(),
          lastMessagePreview: preview.slice(0, 120),
        },
      });

      const io = (strapi as any).io as import('socket.io').Server | undefined;
      if (io) {
        const sanitized = sanitizeMessage(created);
        strapi.log.info('Emitting message:new with attachments:', {
          messageId: sanitized.id,
          hasAttachments: sanitized.attachments?.length > 0,
          attachments: sanitized.attachments,
        });
        io.to(`conversation:${conversationId}`).emit('message:new', {
          conversationId,
          ...sanitized,
        });
      }

      // Notify the other participant
      const conversation = await strapi.entityService.findOne(conversationUid, conversationId, {
        populate: { buyer: { fields: ['id'] }, seller: { fields: ['id'] } },
      }) as any;
      const recipientId = conversation?.buyer?.id === userId
        ? conversation?.seller?.id
        : conversation?.buyer?.id;
      if (recipientId) {
        createNotification({
          strapi,
          recipientId,
          type: 'new_message',
          title: 'New message',
          body: preview.slice(0, 80),
          link: '/Messages',
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
