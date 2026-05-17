import type { Core } from '@strapi/strapi';

const config = ({ env }: Core.Config.Shared.ConfigParams): Core.Config.Plugin => ({
      // Strapi email provider was configured for Nodemailer.
      // This project now uses Resend directly in controllers (see forgot-password + email-otp).
      // Keep Strapi provider disabled to avoid accidental SMTP usage.
      email: {
    config: {
      provider: 'nodemailer',
      settings: {
        defaultFrom: env('EMAIL_FROM', 'usamarahim61@gmail.com'),
        defaultReplyTo: env('EMAIL_FROM', 'usamarahim61@gmail.com'),
      },
    },
  },
});

export default config;