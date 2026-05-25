import sgMail from "@sendgrid/mail";

type SendMailParams = {
  to: string | string[];
  subject: string;
  html: string;
};

export async function sendMail({ to, subject, html }: SendMailParams) {
  const apiKey = process.env.SENDGRID_API_KEY;
  const fromEmail = process.env.SENDGRID_FROM_EMAIL;

  if (!apiKey) {
    throw new Error("SENDGRID_API_KEY is not configured");
  }
  if (!fromEmail) {
    throw new Error("SENDGRID_FROM_EMAIL is not configured");
  }

  sgMail.setApiKey(apiKey);

  const msg = {
    to: Array.isArray(to) ? to : [to],
    from: fromEmail,
    subject,
    html,
  };

  await sgMail.send(msg);
}


