import { Core } from "@strapi/strapi";

// In-memory store: email -> { otp, expiresAt }
const resetStore = new Map<string, { otp: string; expiresAt: number }>();

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes

function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async sendOtp(ctx: any) {
    const { email } = ctx.request.body;
    if (!email) return ctx.badRequest("email is required");

    const user = await strapi
      .query("plugin::users-permissions.user")
      .findOne({ where: { email } });

    // Always respond OK to avoid email enumeration
    if (!user) {
      ctx.send({ ok: true });
      return;
    }

    const otp = generateOtp();
    resetStore.set(email, { otp, expiresAt: Date.now() + OTP_TTL_MS });

    await strapi.plugin("email").service("email").send({
      to: email,
      subject: "Reset your Reluv password",
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:auto">
          <h2 style="color:#cb6f4d">Reset your password</h2>
          <p>Use this code to reset your Reluv password. It expires in 10 minutes.</p>
          <div style="font-size:36px;font-weight:bold;letter-spacing:8px;color:#cb6f4d;margin:24px 0">${otp}</div>
          <p style="color:#888;font-size:12px">If you didn't request this, you can safely ignore this email.</p>
        </div>
      `,
    });

    ctx.send({ ok: true });
  },

  async verifyOtp(ctx: any) {
    const { email, otp } = ctx.request.body;
    if (!email || !otp) return ctx.badRequest("email and otp are required");

    const record = resetStore.get(email);
    if (!record) return ctx.badRequest("No reset code found. Please request a new one.");
    if (Date.now() > record.expiresAt) {
      resetStore.delete(email);
      return ctx.badRequest("Code has expired. Please request a new one.");
    }
    if (record.otp !== otp.trim()) return ctx.badRequest("Invalid code. Please try again.");

    ctx.send({ ok: true });
  },

  async resetPassword(ctx: any) {
    const { email, otp, password } = ctx.request.body;
    if (!email || !otp || !password) return ctx.badRequest("email, otp and password are required");

    const record = resetStore.get(email);
    if (!record) return ctx.badRequest("No reset code found. Please request a new one.");
    if (Date.now() > record.expiresAt) {
      resetStore.delete(email);
      return ctx.badRequest("Code has expired. Please request a new one.");
    }
    if (record.otp !== otp.trim()) return ctx.badRequest("Invalid code. Please try again.");

    resetStore.delete(email);

    const user = await strapi
      .query("plugin::users-permissions.user")
      .findOne({ where: { email } });

    if (!user) return ctx.badRequest("User not found.");

    await strapi
      .plugin("users-permissions")
      .service("user")
      .edit(user.id, { password });

    ctx.send({ ok: true });
  },
});
