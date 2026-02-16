/**
 * category service
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreService('api::category.category', ({ strapi }) => ({
  async bulkDeleteByIds(ids: number[]) {
    const uniqueIds = [...new Set(ids)].filter((v) => Number.isInteger(v) && v > 0);

    if (uniqueIds.length === 0) {
      return 0;
    }

    const deletedCount = await strapi.db.connection.transaction(async (trx) => {
      await trx('categories')
        .whereIn('category_id', uniqueIds)
        .whereNotIn('id', uniqueIds)
        .update({ category_id: null });

      const deleted = await trx('categories').whereIn('id', uniqueIds).del();
      return Number(deleted) || 0;
    });

    return deletedCount;
  },
}));