'use strict';

const TYPE_MAP: Record<string, (table: any, col: string) => any> = {
  string:      (table, col) => table.string(col),
  text:        (table, col) => table.text(col),
  richtext:    (table, col) => table.text(col),
  email:       (table, col) => table.string(col),
  password:    (table, col) => table.string(col),
  uid:         (table, col) => table.string(col),
  enumeration: (table, col) => table.string(col),
  boolean:     (table, col) => table.boolean(col).defaultTo(false),
  integer:     (table, col) => table.integer(col).defaultTo(0),
  biginteger:  (table, col) => table.bigInteger(col).defaultTo(0),
  float:       (table, col) => table.float(col).defaultTo(0),
  decimal:     (table, col) => table.decimal(col).defaultTo(0),
  date:        (table, col) => table.date(col),
  datetime:    (table, col) => table.datetime(col),
  timestamp:   (table, col) => table.timestamp(col),
  time:        (table, col) => table.time(col),
  json:        (table, col) => table.jsonb(col),
};

const INTERNAL_COLUMNS = new Set([
  'id', 'document_id', 'created_at', 'updated_at', 'published_at',
  'created_by_id', 'updated_by_id', 'locale',
]);

const FK_RELATIONS = new Set(['manyToOne', 'oneToOne']);
const JOIN_TABLE_RELATIONS = new Set(['manyToMany']);

async function ensureColumn({ knex, strapi, tableName, columnName, builderFn }: any) {
  const columnInfo = await knex(tableName).columnInfo();
  if (columnInfo[columnName]) return;
  try {
    await knex.schema.table(tableName, (table: any) => builderFn(table));
    strapi.log.info(`[auto-sync] ✅ Added column "${columnName}" to "${tableName}"`);
  } catch (err: any) {
    strapi.log.error(`[auto-sync] ❌ Failed to add column "${columnName}" to "${tableName}": ${err.message}`);
  }
}

async function ensureJoinTable({ knex, strapi, joinTableName, localCol, foreignCol }: any) {
  const exists = await knex.schema.hasTable(joinTableName);
  if (exists) return;
  try {
    await knex.schema.createTable(joinTableName, (table: any) => {
      table.increments('id').primary();
      table.integer(localCol).unsigned();
      table.integer(foreignCol).unsigned();
      table.string('document_id');
      table.float('order').defaultTo(0);
      table.timestamps(true, true);
    });
    strapi.log.info(`[auto-sync] ✅ Created join table "${joinTableName}" (${localCol} ↔ ${foreignCol})`);
  } catch (err: any) {
    strapi.log.error(`[auto-sync] ❌ Failed to create join table "${joinTableName}": ${err.message}`);
  }
}

function resolveTargetTable(attrConfig: any, strapi: any) {
  const targetUID = attrConfig.target;
  if (!targetUID) return null;
  const targetContentType = strapi.contentTypes[targetUID];
  if (!targetContentType) return null;
  return targetContentType.collectionName || null;
}

async function syncScalarColumns({ knex, strapi, tableName, attributes }: any) {
  for (const [attrName, attrConfig] of Object.entries(attributes) as any[]) {
    if (INTERNAL_COLUMNS.has(attrName)) continue;
    const attrType = attrConfig.type;
    if (!attrType || !TYPE_MAP[attrType]) continue;
    await ensureColumn({
      knex, strapi, tableName,
      columnName: attrName,
      builderFn: (table: any) => TYPE_MAP[attrType](table, attrName),
    });
  }
}

async function syncRelations({ knex, strapi, tableName, attributes }: any) {
  for (const [attrName, attrConfig] of Object.entries(attributes) as any[]) {
    if (attrConfig.type !== 'relation') continue;

    const relationType = attrConfig.relation;
    const targetTable  = resolveTargetTable(attrConfig, strapi);

    if (!targetTable) {
      strapi.log.warn(`[auto-sync] ⚠️  Could not resolve target for relation "${attrName}" on "${tableName}" — skipping.`);
      continue;
    }

    if (FK_RELATIONS.has(relationType) && attrConfig.inversedBy === undefined) {
      const fkColumn = `${attrName}_id`;
      await ensureColumn({
        knex, strapi, tableName,
        columnName: fkColumn,
        builderFn: (table: any) => table.integer(fkColumn).unsigned().nullable(),
      });
    }

    if (JOIN_TABLE_RELATIONS.has(relationType)) {
      const isOwner = !attrConfig.mappedBy;
      if (!isOwner) continue;

      const joinTableName = attrConfig.joinTable?.name
        || `${[tableName, targetTable].sort().join('_')}_lnk`;
      const localCol   = attrConfig.joinTable?.joinColumn?.name   || `${tableName.replace(/s$/, '')}_id`;
      const foreignCol = attrConfig.joinTable?.inverseJoinColumn?.name || `${targetTable.replace(/s$/, '')}_id`;

      await ensureJoinTable({ knex, strapi, joinTableName, localCol, foreignCol });
    }
  }
}

export async function autoSyncColumns({ strapi }: { strapi: any }) {
  const knex = strapi.db.connection;
  const allContentTypes = Object.values(strapi.contentTypes);

  strapi.log.info('[auto-sync] 🔄 Starting dynamic column + relation sync...');

  for (const contentType of allContentTypes as any[]) {
    const tableName  = contentType.collectionName;
    const attributes = contentType.attributes;

    if (!tableName || !attributes) continue;

    const tableExists = await knex.schema.hasTable(tableName);
    if (!tableExists) {
      strapi.log.warn(`[auto-sync] ⚠️  Table "${tableName}" does not exist yet — skipping.`);
      continue;
    }

    await syncScalarColumns({ knex, strapi, tableName, attributes });
    await syncRelations({ knex, strapi, tableName, attributes });
  }

  strapi.log.info('[auto-sync] ✅ Sync complete.');
}
