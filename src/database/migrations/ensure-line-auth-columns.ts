const USER_TABLE = "up_users";

export async function ensureLineAuthColumns({ strapi }: { strapi: any }) {
  const knex = strapi.db.connection;
  if (!(await knex.schema.hasTable(USER_TABLE))) {
    throw new Error(`LINE auth migration requires ${USER_TABLE} to exist.`);
  }

  const columns = await knex(USER_TABLE).columnInfo();
  const missingLineUserId = !columns.line_user_id;
  const missingLinePicture = !columns.line_picture;
  const missingDisplayName = !columns.display_name;

  if (!missingLineUserId && !missingLinePicture && !missingDisplayName) return;

  await knex.schema.alterTable(USER_TABLE, (table: any) => {
    if (missingLineUserId) table.string("line_user_id").nullable();
    if (missingLinePicture) table.string("line_picture").nullable();
    if (missingDisplayName) table.string("display_name").nullable();
    if (missingLineUserId) {
      table.unique(["line_user_id"], "up_users_line_user_id_unique");
    }
  });

  strapi.log.info("[LINE auth] User identity columns are ready.");
}
