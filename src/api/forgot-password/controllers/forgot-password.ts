import { Core } from "@strapi/strapi";
import { sendMail } from "../../../lib/email/sendMail";
import { buildLocalAuthUpdate } from "../../../lib/authUserHelpers";

// In-memory store: email -> { otp, expiresAt }
const resetStore = new Map<string, { otp: string; expiresAt: number }>();

// In-memory store for email change: currentEmail -> { otp, expiresAt, newEmail? }
const emailChangeStore = new Map<
  string,
  { otp: string; expiresAt: number; newEmail?: string }
>();

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes

function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

export default ({ strapi }: { strapi: Core.Strapi }) => ({

  /* ─────────────────────────────────────────────
     PASSWORD RESET
  ───────────────────────────────────────────── */

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

    await sendMail({
      to: [email],
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
    if (!email || !otp || !password)
      return ctx.badRequest("email, otp and password are required");

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
      .edit(user.id, buildLocalAuthUpdate(password));

    ctx.send({ ok: true });
  },

  /* ─────────────────────────────────────────────
     EMAIL CHANGE
     Flow:
       1. sendEmailChangeOtp  → OTP sent to CURRENT email
       2. verifyEmailChangeOtp → verify OTP + store newEmail, send OTP to NEW email
       3. confirmNewEmail      → verify new-email OTP, update user record
  ───────────────────────────────────────────── */

  // Step 1 — Send OTP to current email to confirm identity
  async sendEmailChangeOtp(ctx: any) {
    const { email } = ctx.request.body;
    if (!email) return ctx.badRequest("email is required");

    const user = await strapi
      .query("plugin::users-permissions.user")
      .findOne({ where: { email } });

    if (!user) {
      // Respond OK to avoid enumeration
      ctx.send({ ok: true });
      return;
    }

    const otp = generateOtp();
    emailChangeStore.set(email, { otp, expiresAt: Date.now() + OTP_TTL_MS });

    await sendMail({
      to: [email],
      subject: "Confirm your Reluv email change",
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:auto">
          <h2 style="color:#cb6f4d">Confirm it's you</h2>
          <p>We received a request to change the email on your Reluv account.</p>
          <p>Use this code to verify your identity. It expires in 10 minutes.</p>
          <div style="font-size:36px;font-weight:bold;letter-spacing:8px;color:#cb6f4d;margin:24px 0">${otp}</div>
          <p style="color:#888;font-size:12px">If you didn't request this, you can safely ignore this email.</p>
        </div>
      `,
    });

    ctx.send({ ok: true });
  },

  // Step 2 — Verify OTP from current email + send OTP to new email
  async verifyEmailChangeOtp(ctx: any) {
    const { email, otp, newEmail } = ctx.request.body;
    if (!email || !otp || !newEmail)
      return ctx.badRequest("email, otp and newEmail are required");

    if (email.toLowerCase() === newEmail.toLowerCase())
      return ctx.badRequest("New email must be different from your current email.");

    // Check new email isn't already taken
    const existing = await strapi
      .query("plugin::users-permissions.user")
      .findOne({ where: { email: newEmail } });
    if (existing) return ctx.badRequest("This email address is already in use.");

    const record = emailChangeStore.get(email);
    if (!record) return ctx.badRequest("No verification code found. Please request a new one.");
    if (Date.now() > record.expiresAt) {
      emailChangeStore.delete(email);
      return ctx.badRequest("Code has expired. Please request a new one.");
    }
    if (record.otp !== otp.trim()) return ctx.badRequest("Invalid code. Please try again.");

    // OTP verified — generate a fresh OTP for the new email and store newEmail
    const newOtp = generateOtp();
    emailChangeStore.set(email, {
      otp: newOtp,
      expiresAt: Date.now() + OTP_TTL_MS,
      newEmail,
    });

    await sendMail({
      to: [newEmail],
      subject: "Confirm your new Reluv email address",
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:auto">
          <h2 style="color:#cb6f4d">Confirm your new email</h2>
          <p>Enter this code in the Reluv app to complete your email change. It expires in 10 minutes.</p>
          <div style="font-size:36px;font-weight:bold;letter-spacing:8px;color:#cb6f4d;margin:24px 0">${newOtp}</div>
          <p style="color:#888;font-size:12px">If you didn't request this, please contact support immediately.</p>
        </div>
      `,
    });

    ctx.send({ ok: true });
  },

  // Step 3 — Verify OTP sent to new email and update the user record
  async confirmNewEmail(ctx: any) {
    const { email, otp, newEmail } = ctx.request.body;
    if (!email || !otp || !newEmail)
      return ctx.badRequest("email, otp and newEmail are required");

    const record = emailChangeStore.get(email);
    if (!record) return ctx.badRequest("No verification code found. Please request a new one.");
    if (Date.now() > record.expiresAt) {
      emailChangeStore.delete(email);
      return ctx.badRequest("Code has expired. Please request a new one.");
    }
    if (record.otp !== otp.trim()) return ctx.badRequest("Invalid code. Please try again.");

    // Guard: ensure the newEmail in the request matches what was stored in step 2
    if (record.newEmail?.toLowerCase() !== newEmail.toLowerCase())
      return ctx.badRequest("Email mismatch. Please restart the process.");

    emailChangeStore.delete(email);

    const user = await strapi
      .query("plugin::users-permissions.user")
      .findOne({ where: { email } });

    if (!user) return ctx.badRequest("User not found.");

    await strapi
      .plugin("users-permissions")
      .service("user")
      .edit(user.id, { email: newEmail });

    ctx.send({ ok: true });
  },
});
