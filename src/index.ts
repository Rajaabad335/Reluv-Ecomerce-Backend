import { Server } from 'socket.io';
import { repairCategoryAttributeLinks, resolveCategoryAttributeLinkSchema } from './lib/repairCategoryAttributeLinks';
import { autoSyncColumns } from "./database/migrations/auto-sync-columns";
import { createNotification } from './lib/createNotification';


// ─── Seed data (inlined to avoid file I/O on Render) ────────────────────────

/**
 * All attribute definitions keyed by code.
 * Sourced from categoryAttributesUpdated.json.
 */
const ATTRIBUTE_DEFS: Record<string, { name: string; code: string }> = {
  brand:        { name: 'Brand',        code: 'brand'        },
  condition:    { name: 'Condition',    code: 'condition'    },
  colour:       { name: 'Colour',       code: 'colour'       },
  size_women:   { name: 'Size',         code: 'size_women'   },
  size_men:     { name: 'Size',         code: 'size_men'     },
  size_kids:    { name: 'Size',         code: 'size_kids'    },
  shoe_size_women: { name: 'Shoe Size', code: 'shoe_size_women' },
  shoe_size_men:   { name: 'Shoe Size', code: 'shoe_size_men'   },
  shoe_size_kids:  { name: 'Shoe Size', code: 'shoe_size_kids'  },
  material:     { name: 'Material',     code: 'material'     },
  fit:          { name: 'Fit',          code: 'fit'          },
  length:       { name: 'Length',       code: 'length'       },
  neckline:     { name: 'Neckline',     code: 'neckline'     },
  sleeve_length:{ name: 'Sleeve Length',code: 'sleeve_length'},
  pattern:      { name: 'Pattern',      code: 'pattern'      },
  occasion:     { name: 'Occasion',     code: 'occasion'     },
  heel_height:  { name: 'Heel Height',  code: 'heel_height'  },
  gender_kids:  { name: 'Gender',       code: 'gender_kids'  },
  phone_storage:{ name: 'Storage',      code: 'phone_storage'},
  book_format:  { name: 'Format',       code: 'book_format'  },
  game_platform:{ name: 'Platform',     code: 'game_platform'},
  camera_type:  { name: 'Camera Type',  code: 'camera_type'  },
};


// ─── Bootstrap ───────────────────────────────────────────────────────────────

export default {
  register(/* { strapi }: { strapi: Core.Strapi } */) {},

  async bootstrap({ strapi }: { strapi: any }) {
    try {
      // await autoSyncColumns({ strapi });
      const linkSchema = await resolveCategoryAttributeLinkSchema(strapi);
      if (!linkSchema) {
        strapi.log.warn('[Reluv] ⚠  Could not determine category-attribute link table schema. Running repair directly.');
        await repairCategoryAttributeLinks(strapi);
      } else {
        const linkCount = await strapi.db
          .connection(linkSchema.tableName)
          .count('* as count')
          .first();

        const count = Number(linkCount?.count ?? 0);
        strapi.log.info(`[Reluv] Link table ${linkSchema.tableName} has ${count} rows on startup.`);

        if (count === 0) {
          strapi.log.warn('[Reluv] ⚠  Link table is EMPTY — running full repair...');
          await repairCategoryAttributeLinks(strapi);
        } else {
          // Even if links exist, do a quick partial repair to catch
          // any attributes that lost links via Admin UI saves.
          strapi.log.info('[Reluv] Running incremental link check...');
          await repairCategoryAttributeLinks(strapi);
        }
      }
    } catch (err: any) {
      // Never crash Strapi startup due to link repair failure
      strapi.log.error(`[Reluv] ✗ Link repair failed: ${err.message}`);
    }

    // ── 1b. Ensure custom user enum column exists ──────────────────────────
    try {
      const userTable = 'up_users';
      const userColumn = 'notification_daily_limit';
      const hasColumn = await strapi.db.connection.schema.hasColumn(userTable, userColumn);

      if (!hasColumn) {
        strapi.log.info(`[Reluv] Adding missing column ${userTable}.${userColumn}`);
        await strapi.db.connection.schema.alterTable(userTable, (table: any) => {
          table.string(userColumn).defaultTo('unlimited');
        });
      }
    } catch (err: any) {
      strapi.log.error(`[Reluv] ✗ Could not auto-create missing user column: ${err.message}`);
    }

    // ── 2. Socket.IO ────────────────────────────────────────────────────────
    const httpServer = strapi?.server?.httpServer;
    if (!httpServer) {
      strapi.log.warn('[Reluv] Socket.IO disabled: no httpServer found.');
      return;
    }

    const io = new Server(httpServer, {
      cors: {
        origin: '*',
        methods: ['GET', 'POST'],
      },
    });

    strapi.io = io;

    const verifyToken = async (token: string): Promise<number | null> => {
      if (!token) return null;
      try {
        const jwtService = strapi.plugins['users-permissions']?.services?.jwt;
        const payload = await jwtService?.verify(token);
        if (!payload?.id) return null;
        return Number(payload.id);
      } catch {
        return null;
      }
    };

    const conversationUid = 'api::conversation.conversation' as any;
    const messageUid = 'api::message.message' as any;
    const blockUid = 'api::block.block' as any;
    const productUid = 'api::product.product' as any;

    const getDeletedAtForUser = (conversation: any, currentUserId: number): string | null => {
      if (conversation?.buyer?.id === currentUserId) return conversation?.buyerDeletedAt ?? null;
      if (conversation?.seller?.id === currentUserId) return conversation?.sellerDeletedAt ?? null;
      return null;
    };

    const isConversationVisibleToUser = (conversation: any, currentUserId: number): boolean => {
      const deletedAt = getDeletedAtForUser(conversation, currentUserId);
      if (!deletedAt) return true;
      if (!conversation?.lastMessageAt) return false;
      return new Date(conversation.lastMessageAt).getTime() > new Date(deletedAt).getTime();
    };

    const sanitizeConversation = (conversation: any, hasUnread = false) => ({
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

    const sanitizeMessage = (message: any) => ({
      id: message?.id,
      content: message?.content ?? '',
      createdAt: message?.createdAt ?? null,
      sender: message?.sender
        ? {
            id: message.sender.id,
            username: message.sender.username,
            avatar: message.sender.avatar ?? null,
          }
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
      offer: message?.offer
        ? {
            id: message.offer.id,
            offerPrice: message.offer.offerPrice,
            originalPrice: message.offer.originalPrice,
            status: message.offer.status,
            buyer: message.offer.buyer
              ? { id: message.offer.buyer.id, username: message.offer.buyer.username }
              : null,
            seller: message.offer.seller
              ? { id: message.offer.seller.id, username: message.offer.seller.username }
              : null,
          }
        : undefined,
    });

    const isParticipant = async (conversationId: number, userId: number): Promise<boolean> => {
      const rows = await strapi.entityService.findMany(conversationUid, {
        filters: {
          id: { $eq: conversationId },
          $or: [
            { buyer: { id: { $eq: userId } } },
            { seller: { id: { $eq: userId } } },
          ],
        },
        fields: ['id'],
        limit: 1,
      });
      return Boolean(rows?.[0]);
    };

    const getUnreadConversationCount = async (currentUserId: number): Promise<number> => {
      const conversations = (await strapi.entityService.findMany(conversationUid, {
        filters: {
          $or: [
            { buyer: { id: { $eq: currentUserId } } },
            { seller: { id: { $eq: currentUserId } } },
          ],
        },
        populate: {
          buyer: { fields: ['id'] },
          seller: { fields: ['id'] },
        },
        fields: ['id', 'lastMessageAt', 'buyerDeletedAt', 'sellerDeletedAt'],
        limit: 200,
      })) as any[];

      let unreadConversationCount = 0;
      for (const conv of conversations) {
        if (!isConversationVisibleToUser(conv, currentUserId)) continue;
        const otherUserId = conv.buyer?.id === currentUserId ? conv.seller?.id : conv.buyer?.id;
        if (!otherUserId) continue;
        const deletedAt = getDeletedAtForUser(conv, currentUserId);
        const unreadMessages = (await strapi.entityService.findMany(messageUid, {
          filters: {
            conversation: { id: { $eq: conv.id } },
            sender: { id: { $eq: otherUserId } },
            readAt: { $null: true },
            ...(deletedAt ? { createdAt: { $gt: deletedAt } } : {}),
          },
          fields: ['id'],
          limit: 1,
        })) as any[];
        if (unreadMessages.length > 0) unreadConversationCount++;
      }
      return unreadConversationCount;
    };

    const listConversationsForUser = async (currentUserId: number) => {
      const conversations = (await strapi.entityService.findMany(conversationUid, {
        filters: {
          $or: [
            { buyer: { id: { $eq: currentUserId } } },
            { seller: { id: { $eq: currentUserId } } },
          ],
        },
        populate: {
          product: {
            fields: ['id', 'title', 'price'],
            populate: { images: { fields: ['url'] } },
          },
          buyer: {
            fields: ['id', 'username'],
            populate: { avatar: { fields: ['url'] } },
          },
          seller: {
            fields: ['id', 'username'],
            populate: { avatar: { fields: ['url'] } },
          },
        },
        sort: { lastMessageAt: 'desc' },
        limit: 200,
      })) as any[];

      return Promise.all(
        conversations
          .filter((conv) => isConversationVisibleToUser(conv, currentUserId))
          .map(async (conv) => {
            const otherUserId = conv.buyer?.id === currentUserId ? conv.seller?.id : conv.buyer?.id;
            if (!otherUserId) return sanitizeConversation(conv, false);
            const deletedAt = getDeletedAtForUser(conv, currentUserId);
            const unreadMessages = (await strapi.entityService.findMany(messageUid, {
              filters: {
                conversation: { id: { $eq: conv.id } },
                sender: { id: { $eq: otherUserId } },
                readAt: { $null: true },
                ...(deletedAt ? { createdAt: { $gt: deletedAt } } : {}),
              },
              fields: ['id'],
              limit: 1,
            })) as any[];
            return sanitizeConversation(conv, unreadMessages.length > 0);
          }),
      );
    };

    const listMessagesForConversation = async (conversationId: number, currentUserId: number) => {
      const allowed = await isParticipant(conversationId, currentUserId);
      if (!allowed) throw new Error('Not allowed.');

      const conversation = (await strapi.entityService.findOne(conversationUid, conversationId, {
        populate: {
          buyer: { fields: ['id'] },
          seller: { fields: ['id'] },
        },
      })) as any;
      const deletedAt = getDeletedAtForUser(conversation, currentUserId);

      const messages = (await strapi.entityService.findMany(messageUid, {
        filters: {
          conversation: { id: { $eq: conversationId } },
          ...(deletedAt ? { createdAt: { $gt: deletedAt } } : {}),
        },
        populate: {
          sender: true,
          attachments: true,
          offer: { populate: ['buyer', 'seller'] },
        },
        sort: { createdAt: 'asc' },
        limit: 2000,
      })) as any[];

      const unreadMessages = messages.filter((msg) => msg.sender?.id !== currentUserId && !msg.readAt);
      if (unreadMessages.length > 0) {
        await Promise.all(
          unreadMessages.map((msg) =>
            strapi.entityService.update(messageUid, msg.id, {
              data: { readAt: new Date().toISOString() },
            }),
          ),
        );
        io.to(`conversation:${conversationId}`).emit('messages:read', {
          conversationId,
          readBy: currentUserId,
        });
      }

      return messages.map(sanitizeMessage);
    };

    io.use(async (socket: any, next: any) => {
      const authHeader = String(socket.handshake.headers?.authorization || '');
      const headerToken = authHeader.toLowerCase().startsWith('bearer ')
        ? authHeader.slice(7).trim()
        : '';
      const authToken = String(socket.handshake.auth?.token || '');
      const token = authToken || headerToken;

      const userId = await verifyToken(token);
      if (!userId) return next(new Error('Unauthorized'));
      socket.data.userId = userId;
      return next();
    });

    io.on('connection', (socket: any) => {
      const userId = Number(socket.data.userId);
      if (!Number.isInteger(userId) || userId <= 0) {
        socket.disconnect(true);
        return;
      }

      socket.join(`user:${userId}`);

      socket.on('conversation:join', async ({ conversationId }: any) => {
        const id = Number(conversationId);
        if (!Number.isInteger(id) || id <= 0) return;
        const allowed = await isParticipant(id, userId);
        if (!allowed) return;
        socket.join(`conversation:${id}`);
      });

      socket.on('conversations:list', async (_payload: any, ack?: Function) => {
        try {
          const conversations = await listConversationsForUser(userId);
          conversations.forEach((conversation) => {
            if (conversation?.id) socket.join(`conversation:${conversation.id}`);
          });
          ack?.({ ok: true, conversations });
        } catch (error: any) {
          ack?.({ ok: false, message: error.message || 'Failed to load conversations.' });
        }
      });

      socket.on('conversations:unread-count', async (_payload: any, ack?: Function) => {
        try {
          const unreadConversationCount = await getUnreadConversationCount(userId);
          ack?.({ ok: true, unreadConversationCount });
        } catch (error: any) {
          ack?.({ ok: false, message: error.message || 'Failed to get unread count.' });
        }
      });

      socket.on('conversation:createForProduct', async ({ productId, otherUserId }: any, ack?: Function) => {
        try {
          const productIdNum = Number(productId);
          const otherUserIdNum = otherUserId ? Number(otherUserId) : null;
          if (!Number.isInteger(productIdNum) || productIdNum <= 0) {
            throw new Error('productId is required.');
          }

          const productRows = (await strapi.entityService.findMany(productUid, {
            filters: { id: { $eq: productIdNum } },
            fields: ['id'],
            populate: { users_permissions_user: { fields: ['id'] } },
            limit: 1,
          })) as any[];
          const product = productRows?.[0];
          if (!product) throw new Error('Product not found.');

          const sellerId = Number(product?.users_permissions_user?.id);
          if (!Number.isInteger(sellerId) || sellerId <= 0) {
            throw new Error('Seller not found for product.');
          }

          let buyerId = userId;
          if (userId === sellerId) {
            if (!otherUserIdNum || !Number.isInteger(otherUserIdNum) || otherUserIdNum <= 0) {
              throw new Error('otherUserId is required when seller creates a conversation.');
            }
            buyerId = otherUserIdNum;
          }

          const populate = {
            product: {
              fields: ['id', 'title', 'price'],
              populate: { images: { fields: ['url'] } },
            },
            buyer: {
              fields: ['id', 'username'],
              populate: { avatar: { fields: ['url'] } },
            },
            seller: {
              fields: ['id', 'username'],
              populate: { avatar: { fields: ['url'] } },
            },
          };

          const existing = (await strapi.entityService.findMany(conversationUid, {
            filters: {
              product: { id: { $eq: productIdNum } },
              buyer: { id: { $eq: buyerId } },
              seller: { id: { $eq: sellerId } },
            },
            populate,
            limit: 1,
          })) as any[];

          const conversation =
            existing?.[0] ??
            (await strapi.entityService.create(conversationUid, {
              data: {
                product: productIdNum,
                buyer: buyerId,
                seller: sellerId,
                lastMessageAt: new Date().toISOString(),
                lastMessagePreview: '',
              },
              populate,
            }));

          const sanitized = sanitizeConversation(conversation, false);
          socket.join(`conversation:${sanitized.id}`);
          io.to(`user:${buyerId}`).emit('conversation:upsert', { conversation: sanitized });
          io.to(`user:${sellerId}`).emit('conversation:upsert', { conversation: sanitized });
          ack?.({ ok: true, conversation: sanitized });
        } catch (error: any) {
          ack?.({ ok: false, message: error.message || 'Failed to create conversation.' });
        }
      });

      socket.on('messages:list', async ({ conversationId }: any, ack?: Function) => {
        try {
          const id = Number(conversationId);
          if (!Number.isInteger(id) || id <= 0) throw new Error('Conversation id is required.');
          socket.join(`conversation:${id}`);
          const messages = await listMessagesForConversation(id, userId);
          ack?.({ ok: true, messages });
        } catch (error: any) {
          ack?.({ ok: false, message: error.message || 'Failed to load messages.' });
        }
      });

      socket.on('messages:mark-read', async ({ conversationId }: any, ack?: Function) => {
        try {
          const id = Number(conversationId);
          if (!Number.isInteger(id) || id <= 0) throw new Error('Conversation id is required.');
          const allowed = await isParticipant(id, userId);
          if (!allowed) throw new Error('Not allowed.');

          const unreadMessages = (await strapi.entityService.findMany(messageUid, {
            filters: {
              conversation: { id: { $eq: id } },
              sender: { id: { $ne: userId } },
              readAt: { $null: true },
            },
            fields: ['id'],
            limit: 2000,
          })) as any[];

          if (unreadMessages.length > 0) {
            await Promise.all(
              unreadMessages.map((message) =>
                strapi.entityService.update(messageUid, message.id, {
                  data: { readAt: new Date().toISOString() },
                }),
              ),
            );
            io.to(`conversation:${id}`).emit('messages:read', {
              conversationId: id,
              readBy: userId,
            });
            io.to(`user:${userId}`).emit('conversations:unread-count', {
              unreadConversationCount: await getUnreadConversationCount(userId),
            });
          }

          ack?.({ ok: true });
        } catch (error: any) {
          ack?.({ ok: false, message: error.message || 'Failed to mark messages read.' });
        }
      });

      socket.on('conversation:delete', async ({ conversationId }: any, ack?: Function) => {
        try {
          const id = Number(conversationId);
          if (!Number.isInteger(id) || id <= 0) throw new Error('A valid conversation id is required.');

          const conversation = await strapi.db.query(conversationUid).findOne({
            where: { id },
            populate: ['buyer', 'seller'],
          });
          if (!conversation) throw new Error('Conversation not found.');

          const isBuyer = conversation.buyer?.id === userId;
          const isSeller = conversation.seller?.id === userId;
          if (!isBuyer && !isSeller) throw new Error('You are not part of this conversation.');

          const deletionField = isBuyer ? 'buyerDeletedAt' : 'sellerDeletedAt';
          const otherDeletionField = isBuyer ? 'sellerDeletedAt' : 'buyerDeletedAt';
          let permanentlyDeleted = false;

          if (conversation[otherDeletionField]) {
            const messages = await strapi.db.query(messageUid).findMany({
              where: { conversation: { id } },
              populate: ['attachments'],
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
            await strapi.db.query(messageUid).deleteMany({ where: { conversation: { id } } });
            await strapi.db.query(conversationUid).delete({ where: { id } });
            permanentlyDeleted = true;
          } else {
            await strapi.db.query(conversationUid).update({
              where: { id },
              data: { [deletionField]: new Date().toISOString() },
            });
          }

          socket.leave(`conversation:${id}`);
          socket.emit('conversation:deleted', { conversationId: id, permanentlyDeleted });
          ack?.({ ok: true, conversationId: id, permanentlyDeleted });
        } catch (error: any) {
          ack?.({ ok: false, message: error.message || 'Failed to delete conversation.' });
        }
      });

      socket.on('block:status', async ({ userId: targetId }: any, ack?: Function) => {
        try {
          const targetUserId = Number(targetId);
          if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
            throw new Error('A valid user id is required.');
          }
          const iBlockedThem = await strapi.db.query(blockUid).findOne({
            where: { blocker: { id: userId }, blocked: { id: targetUserId } },
          });
          const theyBlockedMe = await strapi.db.query(blockUid).findOne({
            where: { blocker: { id: targetUserId }, blocked: { id: userId } },
          });
          ack?.({ ok: true, iBlockedThem: Boolean(iBlockedThem), theyBlockedMe: Boolean(theyBlockedMe) });
        } catch (error: any) {
          ack?.({ ok: false, message: error.message || 'Failed to get block status.' });
        }
      });

      socket.on('block:set', async ({ userId: targetId, blocked }: any, ack?: Function) => {
        try {
          const targetUserId = Number(targetId);
          if (!Number.isInteger(targetUserId) || targetUserId <= 0) throw new Error('A valid user id is required.');
          if (targetUserId === userId) throw new Error('You cannot block yourself.');

          const existing = await strapi.db.query(blockUid).findOne({
            where: { blocker: { id: userId }, blocked: { id: targetUserId } },
          });

          if (blocked && !existing) {
            const targetUser = await strapi.db.query('plugin::users-permissions.user').findOne({
              where: { id: targetUserId },
            });
            if (!targetUser) throw new Error('User not found.');
            await strapi.db.query(blockUid).create({
              data: { blocker: userId, blocked: targetUserId },
            });
          }
          if (!blocked && existing) {
            await strapi.db.query(blockUid).delete({ where: { id: existing.id } });
          }

          const payload = { blockerId: userId, blockedId: targetUserId, blocked: Boolean(blocked) };
          io.to(`user:${userId}`).emit('block:changed', payload);
          io.to(`user:${targetUserId}`).emit('block:changed', payload);
          ack?.({ ok: true, blocked: Boolean(blocked) });
        } catch (error: any) {
          ack?.({ ok: false, message: error.message || 'Failed to update block status.' });
        }
      });

      socket.on('offer:create', async ({ productId, buyerId, sellerId, offerPrice, message, conversationId, clientOfferId }: any) => {
        try {
          const offerController = strapi.controller('api::offer.offer');
          const mockCtx: any = {
            request: {
              body: { productId, buyerId, sellerId, offerPrice, message, conversationId },
            },
            badRequest: (msg: string) => {
              socket.emit('offer:error', { clientOfferId, message: msg });
              throw new Error(msg);
            },
            notFound: (msg: string) => {
              socket.emit('offer:error', { clientOfferId, message: msg });
              throw new Error(msg);
            },
            created: (data: any) => data,
          };

          const result = await offerController.makeOffer(mockCtx);
          const offer = result?.data;

          if (conversationId && offer?.id) {
            const conversation = await strapi.entityService.findOne(conversationUid, conversationId);
            if (conversation) {
              io.to(`conversation:${conversationId}`).emit('offer:created', {
                clientOfferId,
                offer,
                conversationId,
              });
            }
          }

          socket.emit('offer:created', { clientOfferId, offer });
        } catch (error: any) {
          socket.emit('offer:error', {
            clientOfferId,
            message: error.message || 'Failed to create offer',
          });
        }
      });

      socket.on('offer:respond', async ({ offerId, action, sellerId, conversationId }: any) => {
        try {
          const offerController = strapi.controller('api::offer.offer');
          const mockCtx: any = {
            params: { id: offerId },
            request: {
              body: { action, sellerId, conversationId },
            },
            badRequest: (msg: string) => {
              socket.emit('offer:error', { offerId, message: msg });
              throw new Error(msg);
            },
            notFound: (msg: string) => {
              socket.emit('offer:error', { offerId, message: msg });
              throw new Error(msg);
            },
            forbidden: (msg: string) => {
              socket.emit('offer:error', { offerId, message: msg });
              throw new Error(msg);
            },
            send: (data: any) => data,
          };

          const result = await offerController.respondToOffer(mockCtx);
          const offer = result?.data;

          if (conversationId) {
            io.to(`conversation:${conversationId}`).emit('offer:responded', {
              offerId,
              offer,
              conversationId,
            });
          }

          socket.emit('offer:responded', { offerId, offer });
        } catch (error: any) {
          socket.emit('offer:error', {
            offerId,
            message: error.message || 'Failed to respond to offer',
          });
        }
      });

      socket.on('message:send', async ({ conversationId, content, attachments, metadata, clientMessageId }: any) => {
        const id = Number(conversationId);
        const text = String(content ?? '').trim();
        const attachmentIds = Array.isArray(attachments) ? attachments : [];
        
        strapi.log.info('[Socket] message:send received:', {
          conversationId: id,
          contentLength: text.length,
          attachments: attachmentIds,
          hasMetadata: !!metadata,
          clientMessageId,
          userId,
        });
        
        if (!Number.isInteger(id) || id <= 0) return;
        if (!text && attachmentIds.length === 0) return;
        
        const allowed = await isParticipant(id, userId);
        if (!allowed) return;

        const conversation = await strapi.entityService.findOne(conversationUid, id, {
          populate: {
            buyer: { fields: ['id'] },
            seller: { fields: ['id'] },
          },
        }) as any;
        const receiverId = conversation?.buyer?.id === userId
          ? Number(conversation?.seller?.id)
          : Number(conversation?.buyer?.id);

        if (!Number.isInteger(receiverId) || receiverId <= 0) return;

        const block = await strapi.db.query(blockUid).findOne({
          where: {
            $or: [
              { blocker: { id: userId }, blocked: { id: receiverId } },
              { blocker: { id: receiverId }, blocked: { id: userId } },
            ],
          },
        });
        if (block) {
          socket.emit('message:error', {
            conversationId: id,
            clientMessageId,
            message: 'You cannot send messages to this user.',
          });
          return;
        }

        const messageData: any = {
          conversation: id,
          sender: userId,
          content: text || '',
          attachments: attachmentIds.length > 0 ? attachmentIds : undefined,
          metadata: metadata || undefined,
        };

        // Link offer if provided in metadata
        if (metadata?.offerId) {
          messageData.offer = metadata.offerId;
        }

        const created = await strapi.entityService.create(messageUid, {
          data: messageData,
          populate: ['sender', 'attachments', 'offer'],
        });

        strapi.log.info('[Socket] Message created:', {
          id: created.id,
          hasAttachments: !!created.attachments,
          attachmentsCount: created.attachments?.length || 0,
        });

        const preview = text || (attachmentIds.length > 0 ? `📎 ${attachmentIds.length} file(s)` : 'Message');
        await strapi.entityService.update(conversationUid, id, {
          data: {
            lastMessageAt: new Date().toISOString(),
            lastMessagePreview: preview.slice(0, 120),
          },
        });

        const emitData = {
          conversationId: id,
          clientMessageId: clientMessageId ? String(clientMessageId) : undefined,
          id: created.id,
          content: created.content,
          createdAt: created.createdAt,
          sender: created.sender
            ? {
                id: created.sender.id,
                username: created.sender.username,
                avatar: created.sender.avatar ?? null,
              }
            : null,
          attachments: created.attachments?.map((att: any) => ({
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
          metadata: created.metadata || undefined,
          offer: created.offer ? {
            id: created.offer.id,
            offerPrice: created.offer.offerPrice,
            originalPrice: created.offer.originalPrice,
            status: created.offer.status,
          } : undefined,
        };

        strapi.log.info('[Socket] Emitting message:new with data:', {
          messageId: emitData.id,
          attachmentsCount: emitData.attachments.length,
        });

        io.to(`conversation:${id}`).emit('message:new', emitData);
        io.to(`user:${userId}`).emit('message:new', emitData);
        io.to(`user:${receiverId}`).emit('message:new', emitData);

        const updatedConversation = await strapi.entityService.findOne(conversationUid, id, {
          populate: {
            product: {
              fields: ['id', 'title', 'price'],
              populate: { images: { fields: ['url'] } },
            },
            buyer: {
              fields: ['id', 'username'],
              populate: { avatar: { fields: ['url'] } },
            },
            seller: {
              fields: ['id', 'username'],
              populate: { avatar: { fields: ['url'] } },
            },
          },
        });
        io.to(`user:${userId}`).emit('conversation:upsert', {
          conversation: sanitizeConversation(updatedConversation, false),
        });
        io.to(`user:${receiverId}`).emit('conversation:upsert', {
          conversation: sanitizeConversation(updatedConversation, true),
        });
        io.to(`user:${receiverId}`).emit('conversations:unread-count', {
          unreadConversationCount: await getUnreadConversationCount(receiverId),
        });

        createNotification({
          strapi,
          recipientId: receiverId,
          type: 'new_message',
          title: 'New message',
          body: preview.slice(0, 80),
          link: '/Messages',
        });
      });
    });
  },
  
};
