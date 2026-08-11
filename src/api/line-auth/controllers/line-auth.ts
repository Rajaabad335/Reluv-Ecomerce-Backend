import { filterToExistingColumns } from "../../../lib/authUserHelpers";

const userUid = "plugin::users-permissions.user" as any;
const roleUid = "plugin::users-permissions.role" as any;

const LINE_TOKEN_URL = "https://api.line.me/oauth2/v2.1/token";
const LINE_PROFILE_URL = "https://api.line.me/v2/profile";
const LINE_VERIFY_URL = "https://api.line.me/oauth2/v2.1/verify";

const normalizeUsername = (value: string) => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length >= 3 ? normalized : `${normalized || "user"}123`;
};

const findAvailableUsername = async (strapi: any, base: string) => {
  const normalized = normalizeUsername(base);
  for (let i = 0; i < 100; i++) {
    const username = i === 0 ? normalized : `${normalized}${i + 1}`;
    const existing = await strapi.db
      .query(userUid)
      .findOne({ where: { username }, select: ["id"] });
    if (!existing) return username;
  }
  return `${normalized}${Date.now()}`;
};

const sanitizeUser = async (strapi: any, user: any, ctx: any) => {
  const schema = strapi.getModel(userUid);
  return strapi.contentAPI.sanitize.output(user, schema, {
    auth: ctx.state.auth,
  });
};

// Exchange authorization code for access token (server-side PKCE flow)
const exchangeCodeForToken = async (code: string): Promise<string> => {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: process.env.LINE_CALLBACK_URL!,
    client_id: process.env.LINE_CHANNEL_ID!,
    client_secret: process.env.LINE_CHANNEL_SECRET!,
  });

  const res = await fetch(LINE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`LINE token exchange failed: ${err}`);
  }

  const data = (await res.json()) as { access_token: string };
  return data.access_token;
};

// Verify access token and return LINE userId
const verifyAccessToken = async (accessToken: string): Promise<string> => {
  const res = await fetch(
    `${LINE_VERIFY_URL}?access_token=${encodeURIComponent(accessToken)}`
  );
  if (!res.ok) throw new Error("LINE access token is invalid or expired.");
  const data = (await res.json()) as { client_id: string; expires_in: number };

  const expectedClientId = process.env.LINE_CHANNEL_ID;
  if (expectedClientId && data.client_id !== expectedClientId) {
    throw new Error("LINE token was issued for a different channel.");
  }
  return accessToken;
};

// Fetch LINE user profile
const fetchLineProfile = async (
  accessToken: string
): Promise<{ userId: string; displayName: string; pictureUrl?: string }> => {
  const res = await fetch(LINE_PROFILE_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error("Failed to fetch LINE profile.");
  return res.json() as Promise<{ userId: string; displayName: string; pictureUrl?: string }>;
};

export default {
  async login(ctx: any) {
    try {
      const body = ctx.request.body ?? {};

      // Accept either a pre-obtained access_token (mobile SDK) or an auth code (web flow)
      let accessToken: string = String(body.access_token ?? "").trim();
      const code: string = String(body.code ?? "").trim();

      if (!accessToken && !code) {
        return ctx.badRequest("Either access_token or code is required.");
      }

      if (!accessToken && code) {
        accessToken = await exchangeCodeForToken(code);
      }

      await verifyAccessToken(accessToken);
      const profile = await fetchLineProfile(accessToken);

      const { userId: lineUserId, displayName, pictureUrl } = profile;

      // Find existing user by line_user_id or fall back to username match
      let user = await strapi.db.query(userUid).findOne({
        where: { lineUserId },
        populate: ["role"],
      });

      if (user?.blocked) {
        return ctx.forbidden("Your account has been blocked by an administrator.");
      }

      if (user) {
        // Update picture in case it changed
        user = await strapi.db.query(userUid).update({
          where: { id: user.id },
          data: await filterToExistingColumns(strapi, userUid, {
            linePicture: pictureUrl ?? null,
            confirmed: true,
          }),
          populate: ["role"],
        });
      } else {
        const advancedSettings = (await strapi
          .store({ type: "plugin", name: "users-permissions", key: "advanced" })
          .get()) as { allow_register?: boolean; default_role?: string } | null;

        if (!advancedSettings?.allow_register) {
          return ctx.forbidden("Register action is currently disabled.");
        }

        const defaultRole = await strapi.db.query(roleUid).findOne({
          where: { type: advancedSettings.default_role },
        });

        if (!defaultRole) {
          return ctx.internalServerError("Default user role was not found.");
        }

        const username = await findAvailableUsername(strapi, displayName);

        user = await strapi.db.query(userUid).create({
          data: await filterToExistingColumns(strapi, userUid, {
            username,
            email: `${lineUserId}@line.placeholder`,
            provider: "line",
            confirmed: true,
            blocked: false,
            lineUserId,
            displayName,
            linePicture: pictureUrl ?? null,
            role: { connect: [{ id: defaultRole.id }] },
          }),
          populate: ["role"],
        });
      }

      const jwt = strapi
        .plugin("users-permissions")
        .service("jwt")
        .issue({ id: user.id });

      ctx.body = { jwt, user: await sanitizeUser(strapi, user, ctx) };
    } catch (error: any) {
      strapi.log.error("LINE login failed", error);
      return ctx.badRequest(error?.message || "LINE login failed.");
    }
  },
};
