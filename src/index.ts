import { Server } from 'socket.io';
import { repairCategoryAttributeLinks, resolveCategoryAttributeLinkSchema } from './lib/repairCategoryAttributeLinks';

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

      socket.on('conversation:join', async ({ conversationId }: any) => {
        const id = Number(conversationId);
        if (!Number.isInteger(id) || id <= 0) return;
        const allowed = await isParticipant(id, userId);
        if (!allowed) return;
        socket.join(`conversation:${id}`);
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
      });
    });
  },
  
};