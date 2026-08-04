import type { Core } from "@strapi/strapi";

export default async (
  ctx: { state: { user?: { role?: { name?: string } } } },
  _config: unknown,
  { strapi }: { strapi: Core.Strapi },
): Promise<boolean> => {
  const requiredRoleName =
    strapi.config.get<string>(
      "server.marketplaceAdminRoleName",
      process.env.MARKETPLACE_ADMIN_ROLE_NAME || "Marketplace Admin",
    ) ?? "Marketplace Admin";

  const userRoleName = ctx.state.user?.role?.name;
  return typeof userRoleName === "string" && userRoleName === requiredRoleName;
};
