import { Core } from "@strapi/strapi";
import { sendMail } from "../../../lib/email/sendMail";

/* ─────────────────────────────────────────────
   Shared OTP store for 2FA toggle confirmation
───────────────────────────────────────────── */
const twoFaStore = new Map<string, { otp: string; expiresAt: number; action: "enable" | "disable" }>();
const OTP_TTL_MS = 10 * 60 * 1000;

function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/* ─────────────────────────────────────────────
   Session store
   In production replace with a DB table, Redis,
   or JWT-based session tracking.
   Schema: sessionId -> SessionRecord
───────────────────────────────────────────── */
interface SessionRecord {
  id: string;
  email: string;
  deviceType: "desktop" | "mobile" | "tablet" | "unknown";
  deviceName: string;
  browser: string;
  os: string;
  ipAddress: string;
  location: string;
  lastActive: string; // ISO string
  isCurrent?: boolean;
  createdAt: string;
}

// In-memory map — replace with DB in production
const sessionStore = new Map<string, SessionRecord>();

function parseUserAgent(ua: string): Pick<SessionRecord, "deviceType" | "deviceName" | "browser" | "os"> {
  const isMobile  = /Mobile|Android|iPhone/.test(ua);
  const isTablet  = /iPad|Tablet/.test(ua);
  const deviceType: SessionRecord["deviceType"] = isTablet ? "tablet" : isMobile ? "mobile" : "desktop";

  const browser =
    /Edg\//.test(ua)     ? "Edge"
    : /OPR\//.test(ua)   ? "Opera"
    : /Chrome\//.test(ua)? "Chrome"
    : /Firefox\//.test(ua)?"Firefox"
    : /Safari\//.test(ua) ? "Safari"
    : "Unknown Browser";

  const os =
    /Windows NT/.test(ua) ? "Windows"
    : /Mac OS X/.test(ua) ? "macOS"
    : /Android/.test(ua)  ? "Android"
    : /iPhone|iPad/.test(ua) ? "iOS"
    : /Linux/.test(ua)    ? "Linux"
    : "Unknown OS";

  const deviceName =
    deviceType === "mobile"  ? `${os} Phone`
    : deviceType === "tablet"? `${os} Tablet`
    : `${os} Desktop`;

  return { deviceType, deviceName, browser, os };
}

export default ({ strapi }: { strapi: Core.Strapi }) => ({

  /* ─────────────────────────────────────────────
     2-STEP VERIFICATION
  ───────────────────────────────────────────── */

  // Step 1 — Send OTP to confirm intent to enable/disable 2FA
  async sendTwoFaOtp(ctx: any) {
    const { email, action } = ctx.request.body;
    if (!email || !action) return ctx.badRequest("email and action are required");
    if (action !== "enable" && action !== "disable") return ctx.badRequest("action must be enable or disable");

    const user = await strapi
      .query("plugin::users-permissions.user")
      .findOne({ where: { email } });

    if (!user) {
      ctx.send({ ok: true }); // avoid enumeration
      return;
    }

    const otp = generateOtp();
    twoFaStore.set(email, { otp, expiresAt: Date.now() + OTP_TTL_MS, action });

    const isEnabling = action === "enable";

    await sendMail({
      to: [email],
      subject: `${isEnabling ? "Enable" : "Disable"} 2-Step Verification on Reluv`,
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:auto">
          <h2 style="color:#cb6f4d">${isEnabling ? "Enable" : "Disable"} 2-Step Verification</h2>
          <p>Use this code to ${isEnabling ? "enable" : "disable"} 2-step verification on your Reluv account. It expires in 10 minutes.</p>
          <div style="font-size:36px;font-weight:bold;letter-spacing:8px;color:#cb6f4d;margin:24px 0">${otp}</div>
          <p style="color:#888;font-size:12px">If you didn't request this, you can safely ignore this email.</p>
        </div>
      `,
    });

    ctx.send({ ok: true });
  },

  // Step 2 — Verify OTP and toggle 2FA on the user record
  async toggleTwoFa(ctx: any) {
    const { email, otp, action } = ctx.request.body;
    if (!email || !otp || !action) return ctx.badRequest("email, otp and action are required");

    const record = twoFaStore.get(email);
    if (!record) return ctx.badRequest("No verification code found. Please request a new one.");
    if (Date.now() > record.expiresAt) {
      twoFaStore.delete(email);
      return ctx.badRequest("Code has expired. Please request a new one.");
    }
    if (record.otp !== otp.trim()) return ctx.badRequest("Invalid code. Please try again.");
    if (record.action !== action)  return ctx.badRequest("Action mismatch. Please restart.");

    twoFaStore.delete(email);

    const user = await strapi
      .query("plugin::users-permissions.user")
      .findOne({ where: { email } });

    if (!user) return ctx.badRequest("User not found.");

    // Store 2FA status on the user — add `twoFactorEnabled: boolean` to your User schema
    await strapi
      .plugin("users-permissions")
      .service("user")
      .edit(user.id, { twoFactorEnabled: action === "enable" });

    ctx.send({ ok: true, twoFactorEnabled: action === "enable" });
  },

  /* ─────────────────────────────────────────────
     LOGIN ACTIVITY
  ───────────────────────────────────────────── */

  // Called at login to register a new session — wire into your login flow
  async registerSession(ctx: any) {
    const { email, sessionId } = ctx.request.body;
    if (!email || !sessionId) return ctx.badRequest("email and sessionId are required");

    const ua       = ctx.request.headers["user-agent"] ?? "";
    const ip       = ctx.request.ip ?? ctx.request.headers["x-forwarded-for"] ?? "Unknown";
    const parsed   = parseUserAgent(ua);

    // Simple IP-to-location stub — integrate ip-api.com or similar if needed
    const location = "Unknown Location";

    const session: SessionRecord = {
      id: sessionId,
      email,
      ...parsed,
      ipAddress: Array.isArray(ip) ? ip[0] : ip,
      location,
      lastActive: new Date().toISOString(),
      createdAt:  new Date().toISOString(),
    };

    sessionStore.set(sessionId, session);
    ctx.send({ ok: true });
  },

  // GET — list all sessions for this user
  async getSessions(ctx: any) {
    const { email, currentSessionId } = ctx.query;
    if (!email) return ctx.badRequest("email is required");

    const userSessions = Array.from(sessionStore.values())
      .filter((s) => s.email === email)
      .sort((a, b) => new Date(b.lastActive).getTime() - new Date(a.lastActive).getTime())
      .map((s) => ({ ...s, isCurrent: s.id === currentSessionId }));

    ctx.send({ sessions: userSessions });
  },

  // Revoke a single session
  async revokeSession(ctx: any) {
    const { email, sessionId } = ctx.request.body;
    if (!email || !sessionId) return ctx.badRequest("email and sessionId are required");

    const session = sessionStore.get(sessionId);
    if (!session || session.email !== email) return ctx.badRequest("Session not found.");

    sessionStore.delete(sessionId);
    ctx.send({ ok: true });
  },

  // Revoke all sessions except the current one
  async revokeAllOtherSessions(ctx: any) {
    const { email, currentSessionId } = ctx.request.body;
    if (!email) return ctx.badRequest("email is required");

    let count = 0;
    for (const [id, session] of sessionStore.entries()) {
      if (session.email === email && id !== currentSessionId) {
        sessionStore.delete(id);
        count++;
      }
    }

    ctx.send({ ok: true, revoked: count });
  },

  // Update lastActive timestamp — call this on authenticated requests
  async refreshSession(ctx: any) {
    const { sessionId } = ctx.request.body;
    if (!sessionId) return ctx.badRequest("sessionId is required");

    const session = sessionStore.get(sessionId);
    if (session) {
      session.lastActive = new Date().toISOString();
      sessionStore.set(sessionId, session);
    }

    ctx.send({ ok: true });
  },
});