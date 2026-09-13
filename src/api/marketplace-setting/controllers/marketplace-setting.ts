/**
 * marketplace-setting controller
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreController('api::marketplace-setting.marketplace-setting',
     ({ strapi }) => ({
    async current(ctx) {
      const entries = await strapi
        .documents("api::marketplace-setting.marketplace-setting")
        .findMany({
          status: "published",
          sort: { createdAt: "desc" },
          limit: 1,
          fields: ["commissionRate"],
        });
 
      const entry = entries?.[0];
 
      // Fall back to the schema default (10) if nothing is published yet,
      // so the frontend never breaks on an empty table.
      const commissionRate =
        entry?.commissionRate !== undefined && entry?.commissionRate !== null
          ? Number(entry.commissionRate)
          : 0;
 
      ctx.body = {
        data: { commissionRate },
      };
    },
  })
);
