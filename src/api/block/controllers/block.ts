"use strict";

const { createCoreController } = require("@strapi/strapi").factories;

module.exports = createCoreController("api::block.block", ({ strapi }) => ({

  // POST /api/blocks/block/:userId
  async blockUser(ctx) {
    const { userId: targetId } = ctx.params;
    const userId = ctx.state.user?.id;

    if (!userId) return ctx.unauthorized("You must be logged in.");
    if (Number(targetId) === Number(userId)) return ctx.badRequest("You cannot block yourself.");

    // Check target user exists
    const targetUser = await strapi.db
      .query("plugin::users-permissions.user")
      .findOne({ where: { id: targetId } });

    if (!targetUser) return ctx.notFound("User not found.");

    // Check if already blocked
    const existing = await strapi.db.query("api::block.block").findOne({
      where: {
        blocker: { id: userId },
        blocked: { id: targetId },
      },
    });

    if (existing) {
      const io = strapi.io;
      if (io) {
        io.to(`user:${userId}`).emit("block:changed", {
          blockerId: Number(userId),
          blockedId: Number(targetId),
          blocked: true,
        });
        io.to(`user:${targetId}`).emit("block:changed", {
          blockerId: Number(userId),
          blockedId: Number(targetId),
          blocked: true,
        });
      }
      return ctx.send({ message: "User is already blocked.", alreadyBlocked: true });
    }

    await strapi.db.query("api::block.block").create({
      data: {
        blocker: userId,
        blocked: Number(targetId),
      },
    });

    const io = strapi.io;
    if (io) {
      const payload = {
        blockerId: Number(userId),
        blockedId: Number(targetId),
        blocked: true,
      };
      io.to(`user:${userId}`).emit("block:changed", payload);
      io.to(`user:${targetId}`).emit("block:changed", payload);
    }

    return ctx.send({ message: "User blocked successfully.", blocked: true });
  },

  // POST /api/blocks/unblock/:userId
  async unblockUser(ctx) {
    const { userId: targetId } = ctx.params;
    const userId = ctx.state.user?.id;

    if (!userId) return ctx.unauthorized("You must be logged in.");

    const existing = await strapi.db.query("api::block.block").findOne({
      where: {
        blocker: { id: userId },
        blocked: { id: targetId },
      },
    });

    if (!existing) {
      const io = strapi.io;
      if (io) {
        const payload = {
          blockerId: Number(userId),
          blockedId: Number(targetId),
          blocked: false,
        };
        io.to(`user:${userId}`).emit("block:changed", payload);
        io.to(`user:${targetId}`).emit("block:changed", payload);
      }
      return ctx.send({ message: "User is not blocked.", alreadyUnblocked: true });
    }

    await strapi.db.query("api::block.block").delete({
      where: { id: existing.id },
    });

    const io = strapi.io;
    if (io) {
      const payload = {
        blockerId: Number(userId),
        blockedId: Number(targetId),
        blocked: false,
      };
      io.to(`user:${userId}`).emit("block:changed", payload);
      io.to(`user:${targetId}`).emit("block:changed", payload);
    }

    return ctx.send({ message: "User unblocked successfully.", blocked: false });
  },

  // GET /api/blocks/status/:userId
  async blockStatus(ctx) {
    const { userId: targetId } = ctx.params;
    const userId = ctx.state.user?.id;

    if (!userId) return ctx.unauthorized("You must be logged in.");

    const iBlockedThem = await strapi.db.query("api::block.block").findOne({
      where: { blocker: { id: userId }, blocked: { id: targetId } },
    });

    const theyBlockedMe = await strapi.db.query("api::block.block").findOne({
      where: { blocker: { id: targetId }, blocked: { id: userId } },
    });

    return ctx.send({
      iBlockedThem: !!iBlockedThem,
      theyBlockedMe: !!theyBlockedMe,
    });
  },

  // GET /api/blocks/my-blocks  — list all users I have blocked
  async myBlocks(ctx) {
    const userId = ctx.state.user?.id;
    if (!userId) return ctx.unauthorized("You must be logged in.");

    const blocks = await strapi.db.query("api::block.block").findMany({
      where: { blocker: { id: userId } },
      populate: ["blocked"],
    });

    const blockedUsers = blocks.map((b) => ({
      id: b.blocked?.id,
      username: b.blocked?.username,
      email: b.blocked?.email,
      blockedAt: b.createdAt,
    }));

    return ctx.send({ data: blockedUsers });
  },
}));
