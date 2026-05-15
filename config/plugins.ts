import type { Core } from '@strapi/strapi';

const config = ({ env }: Core.Config.Shared.ConfigParams): Core.Config.Plugin => ({
  email: {
    config: {
      provider: 'nodemailer',
      providerOptions: {
        host: env('SMTP_HOST', 'smtp.gmail.com'),
        port: env.int('SMTP_PORT', 465),

        secure: true,
        family: 4,

        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 10000,

        auth: {
          user: env('SMTP_USER'),
          pass: env('SMTP_PASS'),
        },

        tls: {
          rejectUnauthorized: false,
        },
      },

      settings: {
        defaultFrom: env('EMAIL_FROM', 'noreply@reluv.com'),
        defaultReplyTo: env('EMAIL_FROM', 'noreply@reluv.com'),
      },
    },
  },
});

export default config;