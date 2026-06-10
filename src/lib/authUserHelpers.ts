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

export async function filterToExistingColumns(
  strapi: any,
  uid: string,
  data: Record<string, any>,
) {
  const columnInfo = await strapi.db.query(uid).columnInfo();
  const knownColumns = new Set(
    Object.keys(columnInfo).map((key) => String(key).toLowerCase()),
  );

  return Object.fromEntries(
    Object.entries(data).filter(([key]) => {
      const snakeKey = toSnakeCase(key);
      return knownColumns.has(snakeKey) || knownColumns.has(key.toLowerCase());
    }),
  );
}
