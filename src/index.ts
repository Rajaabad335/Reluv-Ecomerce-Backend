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

    // ── 1. Category-attribute link auto-repair ──────────────────────────────
    //
    // Render free tier spins down the server after ~15 min of inactivity.
    // On cold start, Strapi's migration runner can wipe the many-to-many
    // link table (category_attributes_categories_lnk). Additionally, saving
    // a category-attribute record in the Admin UI does a full relation replace,
    // wiping any categories not checked in the form.
    //
    // This guard runs on every boot and silently re-links anything missing —
    // it is idempotent (never duplicates, never disconnects existing links).
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

      socket.on('message:send', async ({ conversationId, content, clientMessageId }: any) => {
        const id = Number(conversationId);
        const text = String(content ?? '').trim();
        if (!Number.isInteger(id) || id <= 0 || !text) return;
        const allowed = await isParticipant(id, userId);
        if (!allowed) return;

        const created = await strapi.entityService.create(messageUid, {
          data: {
            conversation: id,
            sender: userId,
            content: text,
          },
          populate: {
            sender: {
              fields: ['id', 'username'],
              populate: { avatar: { fields: ['url'] } },
            },
          },
        });

        await strapi.entityService.update(conversationUid, id, {
          data: {
            lastMessageAt: new Date().toISOString(),
            lastMessagePreview: text.slice(0, 120),
          },
        });

        io.to(`conversation:${id}`).emit('message:new', {
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
        });
      });
    });
  },
};