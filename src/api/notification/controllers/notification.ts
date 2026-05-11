import { Core } from "@strapi/strapi";

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  // GET /api/notifications/my  — fetch current user's notifications
  async getMine(ctx: any) {
    const userId = ctx.state?.user?.id;
    if (!userId) return ctx.unauthorized("Authentication required.");

    const notifications = await strapi.entityService.findMany(
      "api::notification.notification" as any,
      {
        filters: { recipient: { id: { $eq: userId } } },
        sort: { createdAt: "desc" },
        limit: 50,
      }
    );

    const unreadCount = (notifications as any[]).filter((n) => !n.read).length;

    ctx.body = { ok: true, notifications, unreadCount };
  },

  // PATCH /api/notifications/:id/read
  async markRead(ctx: any) {
    const userId = ctx.state?.user?.id;
    if (!userId) return ctx.unauthorized("Authentication required.");

    const id = Number(ctx.params?.id);
    if (!id) return ctx.badRequest("id is required.");

    const existing = await strapi.entityService.findOne(
      "api::notification.notification" as any,
      id,
      { populate: ["recipient"] }
    );

    if (!existing || (existing as any).recipient?.id !== userId)
      return ctx.notFound("Notification not found.");

    await strapi.entityService.update(
      "api::notification.notification" as any,
      id,
      { data: { read: true } }
    );

    ctx.body = { ok: true };
  },

  // PATCH /api/notifications/read-all
  async markAllRead(ctx: any) {
    const userId = ctx.state?.user?.id;
    if (!userId) return ctx.unauthorized("Authentication required.");

    const notifications = await strapi.entityService.findMany(
      "api::notification.notification" as any,
      {
        filters: { recipient: { id: { $eq: userId } }, read: { $eq: false } },
        fields: ["id"],
        limit: 200,
      }
    );

    await Promise.all(
      (notifications as any[]).map((n) =>
        strapi.entityService.update(
          "api::notification.notification" as any,
          n.id,
          { data: { read: true } }
        )
      )
    );

    ctx.body = { ok: true };
  },
});
