import { Core } from '@strapi/strapi';
import bcrypt from 'bcryptjs';

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async login(ctx: any) {
    const { identifier, password } = ctx.request.body;

    if (!identifier || !password) {
      return ctx.badRequest('identifier and password are required');
    }

    const user = await strapi.db
      .query('plugin::users-permissions.user')
      .findOne({
        where: {
          $or: [
            { email: identifier.toLowerCase().trim() },
            { username: identifier.trim() },
          ],
          provider: 'local',
        },
        select: ['id', 'username', 'email', 'password', 'confirmed', 'blocked', 'city', 'country'],
      });

    strapi.log.info(`[local-auth] login attempt for: ${identifier} → found: ${!!user}`);

    if (!user) return ctx.badRequest('Invalid email or password.');
    if (user.blocked) return ctx.badRequest('Your account has been blocked.');
    if (!user.confirmed) return ctx.badRequest('Your email is not confirmed.');
    if (!user.password) return ctx.badRequest('This account has no password set. Try logging in with Google.');

    const validPassword = await bcrypt.compare(password, user.password);
    strapi.log.info(`[local-auth] password valid: ${validPassword}, hash prefix: ${user.password?.substring(0, 7)}`);

    if (!validPassword) return ctx.badRequest('Invalid email or password.');

    const jwt = strapi.plugin('users-permissions').service('jwt').issue({ id: user.id });

    ctx.send({
      jwt,
      user: { id: user.id, username: user.username, email: user.email, city: user.city, country: user.country },
    });
  },

  // DEBUG ONLY — remove after fixing. Shows hash info for an email.
  async debugPassword(ctx: any) {
    const { email } = ctx.request.body;
    if (!email) return ctx.badRequest('email required');

    const user = await strapi.db
      .query('plugin::users-permissions.user')
      .findOne({
        where: { email: email.toLowerCase().trim() },
        select: ['id', 'email', 'password', 'confirmed', 'blocked', 'provider'],
      });

    if (!user) return ctx.send({ found: false });

    const hash = user.password ?? '';
    ctx.send({
      found: true,
      confirmed: user.confirmed,
      blocked: user.blocked,
      provider: user.provider,
      hashPrefix: hash.substring(0, 7),       // should be "$2b$10$" or "$2a$10$"
      hashLength: hash.length,                 // should be 60
      looksLikeBcrypt: hash.startsWith('$2'),
      looksDoubleHashed: hash.startsWith('$2') && hash.length > 65,
    });
  },

  // Repair a corrupted password by re-hashing with plain bcrypt
  async fixPassword(ctx: any) {
    const { email, password } = ctx.request.body;
    if (!email || !password) return ctx.badRequest('email and password required');

    const user = await strapi.db
      .query('plugin::users-permissions.user')
      .findOne({
        where: { email: email.toLowerCase().trim() },
        select: ['id', 'password'],
      });

    if (!user) return ctx.badRequest('User not found.');

    const newHash = await bcrypt.hash(password, 10);

    await strapi.db.query('plugin::users-permissions.user').update({
      where: { id: user.id },
      data: { password: newHash },
    });

    strapi.log.info(`[local-auth] password repaired for ${email}`);
    ctx.send({ ok: true, message: 'Password repaired. You can now log in.' });
  },
});
