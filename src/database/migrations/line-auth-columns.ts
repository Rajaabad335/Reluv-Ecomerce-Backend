import type { Core } from "@strapi/strapi";

const USER_TABLE = "up_users";

const LINE_AUTH_COLUMNS = [
  "lineUserId",
  "displayName",
  "linePicture",
] as const;

export async function ensureLineAuthColumns(strapi: Core.Strapi) {
  const knex = strapi.db.connection;

  if (!(await knex.schema.hasTable(USER_TABLE))) {
    throw new Error(`LINE auth migration could not find table ${USER_TABLE}.`);
  }

  for (const columnName of LINE_AUTH_COLUMNS) {
    if (await knex.schema.hasColumn(USER_TABLE, columnName)) continue;

    await knex.schema.alterTable(USER_TABLE, (table) => {
      table.string(columnName).nullable();
    });
    strapi.log.info(`[Reluv] Added LINE auth column ${columnName} to ${USER_TABLE}.`);
  }
}
