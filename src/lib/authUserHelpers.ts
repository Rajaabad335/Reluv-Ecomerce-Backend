export function buildLocalAuthUpdate(password?: string) {
  const updateData: Record<string, any> = {
    provider: "local",
    confirmed: true,
    blocked: false,
    googleLinked: false,
    googlePicture: null,
    googleProfile: null,
    googleAddress: null,
  };

  if (password) {
    updateData.password = password;
  }

  return updateData;
}

const toSnakeCase = (value: string) =>
  value.replace(/([A-Z])/g, "_$1").toLowerCase();

const resolveTableName = (strapi: any, uid: string): string | null => {
  try {
    const model = typeof strapi.getModel === 'function' ? strapi.getModel(uid) : null;
    if (model) {
      if (typeof model.tableName === 'string') return model.tableName;
      if (model.model && typeof model.model.tableName === 'string') return model.model.tableName;
      if (model.collectionName && typeof model.collectionName === 'string') return model.collectionName;
    }
  } catch {
    // ignore missing model metadata
  }

  if (typeof uid === 'string' && uid.includes('.')) {
    const parts = uid.split('.');
    return parts[parts.length - 1];
  }

  return typeof uid === 'string' ? uid : null;
};

const loadColumnNames = async (strapi: any, uid: string): Promise<Set<string>> => {
  const tableName = resolveTableName(strapi, uid);
  if (!tableName) {
    throw new Error(`Unable to resolve table name for uid: ${uid}`);
  }

  const candidateSets: Set<string> = new Set();

  try {
    const rows = await strapi.db.connection('information_schema.columns')
      .select('column_name')
      .where({ table_name: tableName });

    for (const row of rows) {
      candidateSets.add(String(row.column_name).toLowerCase());
    }
  } catch {
    // Ignore if information_schema is unavailable for this DB.
  }

  if (candidateSets.size > 0) {
    return candidateSets;
  }

  try {
    const connection = strapi.db.connection(tableName);
    if (connection && typeof connection.columnInfo === 'function') {
      const info = await connection.columnInfo();
      return new Set(Object.keys(info).map((key) => String(key).toLowerCase()));
    }
  } catch {
    // ignore fallback failure
  }

  const query = typeof strapi.db.query === 'function' ? strapi.db.query(uid) : null;
  if (query && typeof query.columnInfo === 'function') {
    const info = await query.columnInfo();
    return new Set(Object.keys(info).map((key) => String(key).toLowerCase()));
  }

  throw new Error(`Unable to determine existing columns for ${uid}`);
};

export async function filterToExistingColumns(
  strapi: any,
  uid: string,
  data: Record<string, any>,
) {
  const knownColumns = await loadColumnNames(strapi, uid);

  return Object.fromEntries(
    Object.entries(data).filter(([key]) => {
      const snakeKey = toSnakeCase(key);
      return knownColumns.has(snakeKey) || knownColumns.has(key.toLowerCase());
    }),
  );
}
