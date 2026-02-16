/**
 * category controller
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreController('api::category.category', ({ strapi }) => ({
  async bulkDelete(ctx) {
    const body = ctx.request.body as { ids?: unknown };
    const rawIds = Array.isArray(body?.ids) ? body.ids : [];
    const ids = [...new Set(rawIds.map((v) => Number(v)).filter((v) => Number.isInteger(v) && v > 0))];

    if (ids.length === 0) {
      return ctx.badRequest('Body must include a non-empty ids array of positive integers.');
    }

    const deletedCount = await strapi
      .service('api::category.category')
      .bulkDeleteByIds(ids);

    ctx.body = {
      ok: true,
      deletedCount,
      requestedCount: ids.length,
    };
  },
}));