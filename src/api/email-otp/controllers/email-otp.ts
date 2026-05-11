import { Core } from "@strapi/strapi";
import { createNotification } from "../../../lib/createNotification";

// In-memory OTP store: email -> { otp, expiresAt, userData }
const otpStore = new Map<
  string,
  { otp: string; expiresAt: number; username: string; password: string }
>();

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes

function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async send(ctx: any) {
    const { email, username, password } = ctx.request.body;

    if (!email || !username || !password) {
      return ctx.badRequest("email, username and password are required");
    }

    // Check if email already registered
    const existing = await strapi
      .query("plugin::users-permissions.user")
      .findOne({ where: { email } });

    if (existing) {
      return ctx.badRequest("An account with this email already exists.");
    }

    const otp = generateOtp();
    otpStore.set(email, {
      otp,
      expiresAt: Date.now() + OTP_TTL_MS,
      username,
      password,
    });

    await strapi.plugin("email").service("email").send({
      to: email,
      subject: "Your Reluv verification code",
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:auto">
          <h2 style="color:#cb6f4d">Verify your email</h2>
          <p>Use the code below to complete your Reluv registration. It expires in 10 minutes.</p>
          <div style="font-size:36px;font-weight:bold;letter-spacing:8px;color:#cb6f4d;margin:24px 0">${otp}</div>
          <p style="color:#888;font-size:12px">If you didn't request this, you can safely ignore this email.</p>
        </div>
      `,
    });

    ctx.send({ ok: true });
  },

  async verify(ctx: any) {
    const { email, otp } = ctx.request.body;

    if (!email || !otp) {
      return ctx.badRequest("email and otp are required");
    }

    const record = otpStore.get(email);

    if (!record) {
      return ctx.badRequest("No OTP found for this email. Please request a new one.");
    }

    if (Date.now() > record.expiresAt) {
      otpStore.delete(email);
      return ctx.badRequest("OTP has expired. Please request a new one.");
    }

    if (record.otp !== otp.trim()) {
      return ctx.badRequest("Invalid OTP. Please try again.");
    }

    otpStore.delete(email);

    // Register the user via users-permissions plugin
    const pluginStore = await strapi
      .store({ type: "plugin", name: "users-permissions" })
      .get({ key: "advanced" }) as any;

    const defaultRole = await strapi
      .query("plugin::users-permissions.role")
      .findOne({ where: { type: pluginStore?.default_role ?? "authenticated" } });

    const user = await strapi
      .plugin("users-permissions")
      .service("user")
      .add({
        username: record.username,
        email,
        password: record.password,
        provider: "local",
        confirmed: true,
        blocked: false,
        role: defaultRole?.id,
      });

    const jwt = strapi
      .plugin("users-permissions")
      .service("jwt")
      .issue({ id: user.id });

    ctx.send({
      jwt,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
      },
    });

    // Fire-and-forget welcome notification
    createNotification({
      strapi,
      recipientId: user.id,
      type: "welcome",
      title: "Welcome to Reluv! 🎉",
      body: `Hi ${user.username}, your account is ready. Start buying and selling pre-loved fashion!`,
      link: "/",
    });
  },
});
