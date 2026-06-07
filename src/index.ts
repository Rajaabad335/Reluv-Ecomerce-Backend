import { Server } from 'socket.io';
import categoryAttributeMapping from '../categoryAttributeMappingUpdated.json';

// ─── Seed data (inlined to avoid file I/O on Render) ────────────────────────

/**
 * Attribute code → slugs that should be linked to it.
 * Built by inverting categoryAttributeMappingUpdated.json at startup.
 */
const SLUG_TO_ATTR_CODES: Record<string, string[]> = categoryAttributeMapping as Record<string, string[]>;

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


// ─── Helpers ─────────────────────────────────────────────────────────────────

const BATCH_SIZE = 200;
const CAT_ATTR_UID = 'api::category-attribute.category-attribute' as any;
const CAT_UID = 'api::category.category' as any;

const quoteIdentifier = (strapi: any, name: string): string => {
  const client = String(strapi?.db?.connection?.client?.config?.client || '').toLowerCase();
  const quote = client.includes('mysql') ? '`' : '"';
  const escaped = String(name).replace(new RegExp(quote, 'g'), `${quote}${quote}`);
  return `${quote}${escaped}${quote}`;
};

async function resolveCategoryAttributeLinkSchema(strapi: any): Promise<{ tableName: string; attrColumn: string; categoryColumn: string } | null> {
  const detectFromRows = (rows: any[]) => {
    const byTable = new Map<string, string[]>();
    for (const row of rows) {
      const tableName = String(row.table_name);
      const columnName = String(row.column_name);
      const cols = byTable.get(tableName) ?? [];
      cols.push(columnName);
      byTable.set(tableName, cols);
    }

    for (const [tableName, cols] of byTable.entries()) {
      const attrColumn = cols.find((c) => c.toLowerCase().includes('category_attribute') && (c.endsWith('_id') || c.endsWith('Id')));
      const categoryColumn = cols.find((c) => c.toLowerCase().includes('category') && !c.toLowerCase().includes('attribute') && (c.endsWith('_id') || c.endsWith('Id')));
      if (attrColumn && categoryColumn) {
        return { tableName, attrColumn, categoryColumn };
      }
    }
    return null;
  };

  try {
    const rows = await strapi.db.connection('information_schema.columns')
      .select('table_name', 'column_name')
      .where('table_name', 'like', 'category_attributes_categories%lnk');
    const detected = detectFromRows(rows);
    if (detected) return detected;
  } catch {
    // ignore if information_schema is unavailable
  }

  const candidateTables = [
    { tableName: 'category_attributes_categories_lnk', attrColumn: 'category_attribute_id', categoryColumn: 'category_id' },
    { tableName: 'category_attributes_categories_lnk', attrColumn: 'category_attribute_id', categoryColumn: 'categories_id' },
    { tableName: 'category_attributes_categories_lnk', attrColumn: 'categoryAttributeId', categoryColumn: 'categoryId' },
  ];

  for (const candidate of candidateTables) {
    try {
      const info = await strapi.db.connection(candidate.tableName).columnInfo();
      if (info && info[candidate.attrColumn] && info[candidate.categoryColumn]) {
        return candidate;
      }
    } catch {
      // ignore missing table
    }
  }

  return null;
}

/** Build attrCode → slugs map from the slug → codes map */
function buildAttrCodeToSlugs(): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [slug, codes] of Object.entries(SLUG_TO_ATTR_CODES)) {
    for (const code of codes) {
      if (!result[code]) result[code] = [];
      result[code].push(slug);
    }
  }
  return result;
}

const getRowCount = (result: any): number => {
  if (typeof result?.rowCount === 'number') return result.rowCount;
  if (Array.isArray(result?.rows)) return result.rows.length;
  if (Array.isArray(result?.[0])) return result[0].length;
  return 0;
};

/** Re-link all category-attribute → category relations idempotently */
async function repairCategoryAttributeLinks(strapi: any): Promise<void> {
  const start = Date.now();
  strapi.log.info('[Reluv] 🔧 Repairing category-attribute → category links...');

  const schema = await resolveCategoryAttributeLinkSchema(strapi);
  if (!schema) {
    strapi.log.warn('[Reluv] ⚠  Could not determine link table schema — skipping link repair.');
    return;
  }

  const attrCodeToSlugs = buildAttrCodeToSlugs();

  const allCategories = await strapi.db.connection('categories').select('id', 'slug');
  if (allCategories.length === 0) {
    strapi.log.warn('[Reluv] ⚠  No categories found — skipping link repair.');
    return;
  }

  const categoryIdBySlug: Record<string, number> = {};
  for (const cat of allCategories) {
    categoryIdBySlug[cat.slug] = Number(cat.id);
  }

  const allAttrs = await strapi.db.connection('category_attributes').select('id', 'code');
  const attrIdByCode: Record<string, number> = {};
  for (const attr of allAttrs) {
    attrIdByCode[attr.code] = Number(attr.id);
  }

  const missingLinks: Array<{ attrId: number; categoryId: number; attrCode: string; categorySlug: string }> = [];
  for (const [attrCode, slugs] of Object.entries(attrCodeToSlugs)) {
    const attrId = attrIdByCode[attrCode];
    if (!attrId) continue;

    for (const slug of slugs) {
      const categoryId = categoryIdBySlug[slug];
      if (!categoryId) continue;
      missingLinks.push({ attrId, categoryId, attrCode, categorySlug: slug });
    }
  }

  if (missingLinks.length === 0) {
    strapi.log.info('[Reluv] ✓ No attribute links to add.');
    return;
  }

  let totalLinked = 0;
  let errors = 0;

  for (let i = 0; i < missingLinks.length; i += BATCH_SIZE) {
    const batch = missingLinks.slice(i, i + BATCH_SIZE);
    const placeholders = batch.map(() => '(?::integer, ?::integer)').join(', ');
    const params = batch.flatMap((row) => [row.attrId, row.categoryId]);

    const rawQuery = `
      INSERT INTO ${quoteIdentifier(strapi, schema.tableName)} (${quoteIdentifier(strapi, schema.attrColumn)}, ${quoteIdentifier(strapi, schema.categoryColumn)})
      SELECT v.attr_id, v.cat_id
      FROM (VALUES ${placeholders}) AS v(attr_id, cat_id)
      LEFT JOIN ${quoteIdentifier(strapi, schema.tableName)} l
        ON l.${quoteIdentifier(strapi, schema.attrColumn)} = v.attr_id
        AND l.${quoteIdentifier(strapi, schema.categoryColumn)} = v.cat_id
      WHERE l.${quoteIdentifier(strapi, schema.attrColumn)} IS NULL
      RETURNING 1
    `;

    try {
      const result = await strapi.db.connection.raw(rawQuery, params);
      totalLinked += getRowCount(result);
    } catch (err: any) {
      strapi.log.error(`[Reluv] ✗ Error inserting batch: ${err.message}`);
      errors++;
    }
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  strapi.log.info(
    `[Reluv] ✓ Link repair done in ${elapsed}s — newly linked: ${totalLinked}, batches: ${Math.ceil(missingLinks.length / BATCH_SIZE)}, errors: ${errors}`
  );
}

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