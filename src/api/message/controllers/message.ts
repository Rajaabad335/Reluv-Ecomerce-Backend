/**
 * message controller
 */

import { factories } from '@strapi/strapi';
import { createNotification } from '../../../lib/createNotification';
import { resolveCanonicalConversation } from '../../../lib/unified-conversations';

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
    alternativeText: att.alternativeText,
    caption: att.caption,
    hash: att.hash,
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
    editedAt: message.offer.editedAt ?? null,
    editCount: message.offer.editCount ?? 0,
    seenAt: message.offer.seenAt ?? null,
    productTitle: message.offer.productTitle ?? message.offer.product?.title ?? null,
    productImage: message.offer.productImage ?? null,
    product: message.offer.product ? {
      id: message.offer.product.id,
      documentId: message.offer.product.documentId ?? null,
      title: message.offer.product.title ?? null,
      price: message.offer.product.price ?? null,
      productStatus: message.offer.product.productStatus ?? null,
    } : null,
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

      const canonical = await resolveCanonicalConversation(strapi, conversationId);
      if (!canonical) return ctx.notFound('Conversation not found.');
      const canonicalId = Number(canonical.id);

      const conversation = await strapi.entityService.findOne(conversationUid, canonicalId, {
        populate: {
          buyer: { fields: ['id'] },
          seller: { fields: ['id'] },
        },
      }) as any;
      const deletedAt = conversation?.buyer?.id === userId
        ? conversation?.buyerDeletedAt
        : conversation?.sellerDeletedAt;

      const messages = await strapi.entityService.findMany(messageUid, {
        filters: {
          conversation: { id: { $eq: canonicalId } },
          ...(deletedAt ? { createdAt: { $gt: deletedAt } } : {}),
        },
        populate: {
          sender: true,
          attachments: true,
          offer: {
            populate: ['buyer', 'seller', 'product']
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
          io.to(`conversation:${canonicalId}`).emit('messages:read', {
            conversationId: canonicalId,
            readBy: userId,
          });
        }
      }

      ctx.body = {
        ok: true,
        conversationId: canonicalId,
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
      const attachmentIds = Array.isArray(ctx.request?.body?.attachments)
        ? ctx.request.body.attachments
            .map((value: any) => Number(value?.id ?? value))
            .filter((value: number) => Number.isInteger(value) && value > 0)
        : [];

      if (!Number.isInteger(conversationId) || conversationId <= 0) {
        return ctx.badRequest('conversationId is required.');
      }
      if (!content && (!attachmentIds || attachmentIds.length === 0)) {
        return ctx.badRequest('content or attachments required.');
      }

      const canAccess = await assertParticipant(strapi, conversationId, userId);
      if (!canAccess) return ctx.unauthorized('Not allowed.');

      const canonical = await resolveCanonicalConversation(strapi, conversationId);
      if (!canonical) return ctx.notFound('Conversation not found.');
      const canonicalId = Number(canonical.id);

      // Get conversation to find the receiver
      const conversation = await strapi.entityService.findOne(conversationUid, canonicalId, {
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
        conversation: canonicalId,
        sender: userId,
        content: content || '',
      };

      if (ctx.request?.body?.metadata?.offerId) {
        messageData.offer = ctx.request.body.metadata.offerId;
      }

      let created = await strapi.entityService.create(messageUid, {
        data: {
          ...messageData,
          metadata: ctx.request?.body?.metadata || undefined,
        },
        populate: {
          sender: true,
          attachments: true,
          offer: {
            populate: ['buyer', 'seller', 'product']
          }
        },
      });

      // Strapi 5 does not officially support `connect` on media attributes
      // through the entity service and silently drops the link. Attach the
      // uploaded files via the query layer, then reload the populated message.
      if (attachmentIds.length > 0 && !(created.attachments?.length > 0)) {
        // Link from the file side: the upload_file_morph join rows are owned
        // by the upload plugin's file entity (`related` morph relation).
        for (const attachmentId of attachmentIds) {
          try {
            await strapi.db.query('plugin::upload.file').update({
              where: { id: attachmentId },
              data: { related: [{ id: created.id, __type: messageUid }] },
            });
          } catch (linkError) {
            strapi.log.warn('Failed to link attachment:', {
              messageId: created.id,
              attachmentId,
              error: linkError instanceof Error ? linkError.message : String(linkError),
            });
          }
        }
        created = await strapi.entityService.findOne(messageUid, created.id, {
          populate: {
            sender: true,
            attachments: true,
            offer: {
              populate: ['buyer', 'seller', 'product']
            }
          },
        }) as any;
      }

      strapi.log.info('Created message with attachments:', {
        messageId: created.id,
        attachmentIds,
        hasAttachments: !!created.attachments,
        attachmentsCount: created.attachments?.length || 0,
      });

      const preview = content || (attachmentIds.length > 0 ? `📎 ${attachmentIds.length} file(s)` : 'Message');
      await strapi.entityService.update(conversationUid, canonicalId, {
        data: {
          lastMessageAt: new Date().toISOString(),
          lastMessagePreview: preview.slice(0, 120),
        },
      });

      const io = (strapi as any).io as import('socket.io').Server | undefined;
      if (io) {
        const sanitized = sanitizeMessage(created);
        let messageTarget = io.to(`conversation:${canonicalId}`).to(`user:${userId}`);
        if (receiverId) {
          messageTarget = messageTarget.to(`user:${receiverId}`);
        }
        messageTarget.emit('message:new', { conversationId: canonicalId, ...sanitized });

        if (receiverId) {
          // Update the receiver's conversation list and unread count
          const updatedConversation = await strapi.entityService.findOne(conversationUid, canonicalId, {
            populate: {
              product: { fields: ['id', 'title', 'price'], populate: { images: { fields: ['url'] } } },
              buyer: { fields: ['id', 'username'], populate: { avatar: { fields: ['url'] } } },
              seller: { fields: ['id', 'username'], populate: { avatar: { fields: ['url'] } } },
            },
          });
          const sanitizeConv = (conv: any, hasUnread: boolean) => ({
            id: conv?.id,
            product: conv?.product ? { id: conv.product.id, title: conv.product.title, price: conv.product.price, images: conv.product.images ?? [] } : null,
            buyer: conv?.buyer ? { id: conv.buyer.id, username: conv.buyer.username, avatar: conv.buyer.avatar ?? null } : null,
            seller: conv?.seller ? { id: conv.seller.id, username: conv.seller.username, avatar: conv.seller.avatar ?? null } : null,
            lastMessagePreview: conv?.lastMessagePreview ?? null,
            lastMessageAt: conv?.lastMessageAt ?? null,
            updatedAt: conv?.updatedAt ?? null,
            hasUnread,
          });
          io.to(`user:${receiverId}`).emit('conversation:upsert', { conversation: sanitizeConv(updatedConversation, true) });
        }
      }

      // Notify the receiver
      //  const userNotificationSetting = await strapi.config.index.findUserNotificationSettingByUserID(receiverId)
      //   const isCreateNotification =   userNotificationSetting?.notificationSettings?.messages;
      if (receiverId 
        // && isCreateNotification
      ) {
        createNotification({
          strapi,
          recipientId: receiverId,
          type: 'new_message',
          title: 'New message',
          body: preview.slice(0, 80),
          link: `/Messages?conversationId=${canonicalId}`,
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
