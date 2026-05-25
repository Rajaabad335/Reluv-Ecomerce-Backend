# TODO - SendGrid Email Integration

## Plan steps
- [x] Inspect current email sending helper and its callers.

- [x] Replace Nodemailer SMTP implementation in `src/lib/email/sendMail.ts` with SendGrid API usage.

- [x] Add `@sendgrid/mail` dependency to `package.json`.
- [x] Ensure `sendMail({to, subject, html})` signature remains unchanged.

- [x] Document required env vars (`SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL`).

- [x] Install dependencies and restart Strapi.

- [x] Test OTP + Forgot Password endpoints.


