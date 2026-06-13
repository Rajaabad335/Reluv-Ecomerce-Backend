/**
 * message controller
 */

import { factories } from '@strapi/strapi';
import { createNotification } from '../../../lib/createNotification';

const conversationUid = 'api::conversation.conversation' as any;
const messageUid = 'api::message.message' as any;
const blockUid = 'api::block.block' as any;

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
  metadata: message?.metadata || undefined,
  offer: message?.offer ? {
    id: message.offer.id,
    offerPrice: message.offer.offerPrice,
    originalPrice: message.offer.originalPrice,
    status: message.offer.status,
    buyer: message.offer.buyer ? {
      id: message.offer.buyer.id,
      username: message.offer.buyer.username
    } : null,
    seller: message.offer.seller ? {
      id: message.offer.seller.id,
      username: message.offer.seller.username
    } : null,
  } : undefined,
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

const canUsersMessage = async (strapi: any, senderId: number, receiverId: number): Promise<boolean> => {
  const block = await strapi.db.query(blockUid).findOne({
    where: {
      $or: [
        { blocker: { id: senderId }, blocked: { id: receiverId } },
        { blocker: { id: receiverId }, blocked: { id: senderId } },
      ],
    },
  });
  return !block;
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
        populate: {
          sender: true,
          attachments: true,
          offer: {
            populate: ['buyer', 'seller']
          }
        },
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

      // Get conversation to find the receiver
      const conversation = await strapi.entityService.findOne(conversationUid, conversationId, {
        populate: { buyer: { fields: ['id'] }, seller: { fields: ['id'] } },
      }) as any;

      const receiverId = conversation?.buyer?.id === userId
        ? conversation?.seller?.id
        : conversation?.buyer?.id;

      // Block check — prevent sending if either party has blocked the other
      if (receiverId) {
        const allowed = await canUsersMessage(strapi, userId, receiverId);
        if (!allowed) {
          return ctx.forbidden('You cannot send messages to this user.');
        }
      }

      const messageData: any = {
        conversation: conversationId,
        sender: userId,
        content: content || '',
      };

      if (ctx.request?.body?.metadata?.offerId) {
        messageData.offer = ctx.request.body.metadata.offerId;
      }

      const created = await strapi.entityService.create(messageUid, {
        data: {
          ...messageData,
          attachments: attachmentIds && attachmentIds.length > 0 ? attachmentIds : undefined,
          metadata: ctx.request?.body?.metadata || undefined,
        },
        populate: {
          sender: true,
          attachments: true,
          offer: {
            populate: ['buyer', 'seller']
          }
        },
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

      // Notify the receiver
      if (receiverId) {
        createNotification({
          strapi,
          recipientId: receiverId,
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