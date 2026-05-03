const userUid = 'plugin::users-permissions.user' as any;
const roleUid = 'plugin::users-permissions.role' as any;

const GOOGLE_TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';

type GoogleTokenInfo = {
  aud?: string;
  email?: string;
  email_verified?: string | boolean;
  name?: string;
  picture?: string;
};

const normalizeUsername = (value: string) => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized.length >= 3 ? normalized : `${normalized || 'user'}123`;
};

const findAvailableUsername = async (strapi: any, base: string) => {
  const normalized = normalizeUsername(base);

  for (let index = 0; index < 100; index += 1) {
    const username = index === 0 ? normalized : `${normalized}${index + 1}`;
    const existing = await strapi.db.query(userUid).findOne({
      where: { username },
      select: ['id'],
    });

    if (!existing) return username;
  }

  return `${normalized}${Date.now()}`;
};

const sanitizeUser = async (strapi: any, user: any, ctx: any) => {
  const schema = strapi.getModel(userUid);
  return strapi.contentAPI.sanitize.output(user, schema, { auth: ctx.state.auth });
};

const verifyGoogleAccessToken = async (accessToken: string): Promise<GoogleTokenInfo> => {
  const response = await fetch(
    `${GOOGLE_TOKENINFO_URL}?access_token=${encodeURIComponent(accessToken)}`
  );

  if (!response.ok) {
    throw new Error('Google token is invalid or expired.');
  }

  return response.json() as Promise<GoogleTokenInfo>;
};

export default {
  async login(ctx: any) {
    try {
      const accessToken = String(ctx.request.body?.access_token ?? '').trim();
      if (!accessToken) return ctx.badRequest('Google access token is required.');

      const profile = await verifyGoogleAccessToken(accessToken);
      const email = String(profile.email ?? '').trim().toLowerCase();
      const emailVerified = profile.email_verified === true || profile.email_verified === 'true';
      const expectedClientId = process.env.GOOGLE_CLIENT_ID || process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;

      if (!email || !emailVerified) {
        return ctx.unauthorized('Google account email is not verified.');
      }

      if (expectedClientId && profile.aud !== expectedClientId) {
        return ctx.unauthorized('Google token was issued for a different app.');
      }

      const existingUsers = await strapi.db.query(userUid).findMany({
        where: { email },
        populate: ['role'],
      });

      let user =
        existingUsers.find((candidate: any) => candidate.provider === 'google') || existingUsers[0];

      if (user?.blocked) {
        return ctx.forbidden('Your account has been blocked by an administrator.');
      }

      if (user) {
        user = await strapi.db.query(userUid).update({
          where: { id: user.id },
          data: {
            googleLinked: true,
            confirmed: true,
          },
          populate: ['role'],
        });
      } else {
        const advancedSettings = (await strapi
          .store({ type: 'plugin', name: 'users-permissions', key: 'advanced' })
          .get()) as { allow_register?: boolean; default_role?: string } | null;

        if (!advancedSettings?.allow_register) {
          return ctx.forbidden('Register action is currently disabled.');
        }

        const defaultRole = await strapi.db.query(roleUid).findOne({
          where: { type: advancedSettings.default_role },
        });

        if (!defaultRole) {
          return ctx.internalServerError('Default user role was not found.');
        }

        user = await strapi.db.query(userUid).create({
          data: {
            username: await findAvailableUsername(strapi, profile.name || email.split('@')[0]),
            email,
            provider: 'google',
            role: defaultRole.id,
            confirmed: true,
            googleLinked: true,
          },
          populate: ['role'],
        });
      }

      const jwt = strapi.plugin('users-permissions').service('jwt').issue({ id: user.id });
      ctx.body = {
        jwt,
        user: await sanitizeUser(strapi, user, ctx),
      };
    } catch (error: any) {
      strapi.log.error('Google login failed', error);
      return ctx.badRequest(error?.message || 'Google login failed.');
    }
  },
};
