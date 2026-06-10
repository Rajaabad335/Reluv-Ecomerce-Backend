import categoryAttributeMapping from '../../categoryAttributeMappingUpdated.json';

const BATCH_SIZE = 200;
const SLUG_TO_ATTR_CODES: Record<string, string[]> = categoryAttributeMapping as Record<string, string[]>;

const quoteIdentifier = (strapi: any, name: string): string => {
  const client = String(strapi?.db?.connection?.client?.config?.client || '').toLowerCase();
  const quote = client.includes('mysql') ? '`' : '"';
  const escaped = String(name).replace(new RegExp(quote, 'g'), `${quote}${quote}`);
  return `${quote}${escaped}${quote}`;
};

export async function resolveCategoryAttributeLinkSchema(strapi: any): Promise<{ tableName: string; attrColumn: string; categoryColumn: string } | null> {
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
      .where((builder: any) =>
        builder
          .where('table_name', 'like', 'category_attributes_categories%lnk')
          .orWhere('table_name', 'like', 'category_attribute_categories%lnk')
          .orWhere('table_name', 'like', '%category_attributes%category%')
          .orWhere('table_name', 'like', '%category%attribute%')
      );
    const detected = detectFromRows(rows);
    if (detected) return detected;
  } catch {
    // ignore if information_schema is unavailable
  }

  const candidateTables = [
    { tableName: 'category_attributes_categories_lnk', attrColumn: 'category_attribute_id', categoryColumn: 'category_id' },
    { tableName: 'category_attribute_categories_lnk', attrColumn: 'category_attribute_id', categoryColumn: 'category_id' },
    { tableName: 'category_attributes_categories_link', attrColumn: 'category_attribute_id', categoryColumn: 'category_id' },
    { tableName: 'category_attribute_categories_link', attrColumn: 'category_attribute_id', categoryColumn: 'category_id' },
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
  if (Array.isArray(result?.[0])) return result?.[0].length;
  return 0;
};

export async function repairCategoryAttributeLinks(strapi: any): Promise<void> {
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
