import nodemailer from "nodemailer";
import sgMail from "@sendgrid/mail";

type SendMailParams = {
  to: string | string[];
  subject: string;
  html: string;
};

export async function sendMail({ to, subject, html }: SendMailParams) {
  const provider = (process.env.EMAIL_PROVIDER ?? "smtp").toLowerCase();
  const fromEmail = process.env.EMAIL_FROM ?? process.env.SENDGRID_FROM_EMAIL;

  if (!fromEmail) {
    throw new Error("EMAIL_FROM or SENDGRID_FROM_EMAIL is not configured");
  }

  if (provider === "sendgrid") {
    const apiKey = process.env.SENDGRID_API_KEY;
    if (!apiKey) throw new Error("SENDGRID_API_KEY is not configured");

    sgMail.setApiKey(apiKey);
    await sgMail.send({
      to: Array.isArray(to) ? to : [to],
      from: fromEmail,
      subject,
      html,
    });
    return;
  }

  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT ?? 587);
  const user = process.env.SMTP_USER ?? process.env.SMTP_USERNAME;
  const password = process.env.SMTP_PASS ?? process.env.SMTP_PASSWORD;

  if (!host || !user || !password) {
    throw new Error("SMTP_HOST, SMTP_USER, and SMTP_PASS are required");
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass: password },
  });

  await transporter.sendMail({
    to: Array.isArray(to) ? to : [to],
    from: fromEmail,
    subject,
    html,
  });
}


