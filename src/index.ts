import { Server } from 'socket.io';

export default {
  /**
   * An asynchronous register function that runs before
   * your application is initialized.
   *
   * This gives you an opportunity to extend code.
   */
  register(/* { strapi }: { strapi: Core.Strapi } */) {},

  /**
   * An asynchronous bootstrap function that runs before
   * your application gets started.
   *
   * This gives you an opportunity to set up your data model,
   * run jobs, or perform some special logic.
   */
  async bootstrap({ strapi }) {
    const httpServer = strapi?.server?.httpServer;
    if (!httpServer) {
      strapi.log.warn('Socket.IO disabled: no httpServer found.');
      return;
    }

    const io = new Server(httpServer, {
      cors: {
        origin: '*',
        methods: ['GET', 'POST'],
      },
    });

    strapi.io = io;

    const verifyToken = async (token: string) => {
      if (!token) return null;
      try {
        const jwtService = strapi.plugins['users-permissions']?.services?.jwt;
        const payload = await jwtService?.verify(token);
        if (!payload?.id) return null;
        return Number(payload.id);
      } catch {
        return null;
      }
    };

    const conversationUid = 'api::conversation.conversation' as any;
    const messageUid = 'api::message.message' as any;

    const isParticipant = async (conversationId: number, userId: number) => {
      const rows = await strapi.entityService.findMany(conversationUid, {
        filters: {
          id: { $eq: conversationId },
          $or: [{ buyer: { id: { $eq: userId } } }, { seller: { id: { $eq: userId } } }],
        },
        fields: ['id'],
        limit: 1,
      });
      return Boolean(rows?.[0]);
    };

    io.use(async (socket, next) => {
      const authHeader = String(socket.handshake.headers?.authorization || '');
      const headerToken = authHeader.toLowerCase().startsWith('bearer ')
        ? authHeader.slice(7).trim()
        : '';
      const authToken = String(socket.handshake.auth?.token || '');
      const token = authToken || headerToken;

      const userId = await verifyToken(token);
      if (!userId) return next(new Error('Unauthorized'));
      socket.data.userId = userId;
      return next();
    });

    io.on('connection', (socket) => {
      const userId = Number(socket.data.userId);
      if (!Number.isInteger(userId) || userId <= 0) {
        socket.disconnect(true);
        return;
      }

      socket.on('conversation:join', async ({ conversationId }) => {
        const id = Number(conversationId);
        if (!Number.isInteger(id) || id <= 0) return;
        const allowed = await isParticipant(id, userId);
        if (!allowed) return;
        socket.join(`conversation:${id}`);
      });

      socket.on('message:send', async ({ conversationId, content, clientMessageId }) => {
        const id = Number(conversationId);
        const text = String(content ?? '').trim();
        if (!Number.isInteger(id) || id <= 0 || !text) return;
        const allowed = await isParticipant(id, userId);
        if (!allowed) return;

        const created = await strapi.entityService.create(messageUid, {
          data: {
            conversation: id,
            sender: userId,
            content: text,
          },
          populate: { sender: { fields: ['id', 'username'], populate: { avatar: { fields: ['url'] } } } },
        });

        await strapi.entityService.update(conversationUid, id, {
          data: {
            lastMessageAt: new Date().toISOString(),
            lastMessagePreview: text.slice(0, 120),
          },
        });

        io.to(`conversation:${id}`).emit('message:new', {
          conversationId: id,
          clientMessageId: clientMessageId ? String(clientMessageId) : undefined,
          id: created.id,
          content: created.content,
          createdAt: created.createdAt,
          sender: created.sender
            ? { id: created.sender.id, username: created.sender.username, avatar: created.sender.avatar ?? null }
            : null,
        });
      });
    });
  },
};
