'use strict';

const TABLE_NAME = 'category_attributes_categories_lnk';

module.exports = {
  async up(knex) {
    const exists = await knex.schema.hasTable(TABLE_NAME);
    if (exists) return;

    await knex.schema.createTable(TABLE_NAME, (table) => {
      table.increments('id').primary();
      table.integer('category_attribute_id').notNullable();
      table.integer('category_id').notNullable();
      table.integer('category_attribute_ord');
      table.integer('category_ord');

      table.unique(['category_attribute_id', 'category_id'], {
        indexName: 'category_attributes_categories_lnk_unique',
      });
      table.index(['category_attribute_id'], 'category_attributes_categories_lnk_attr_idx');
      table.index(['category_id'], 'category_attributes_categories_lnk_cat_idx');
    });
  },

  async down(knex) {
    await knex.schema.dropTableIfExists(TABLE_NAME);
  },
};
