"use strict";

module.exports = {
  routes: [
    {
      method: "POST",
      path: "/blocks/block/:userId",
      handler: "block.blockUser",
      config: { policies: [], middlewares: [] },
    },
    {
      method: "POST",
      path: "/blocks/unblock/:userId",
      handler: "block.unblockUser",
      config: { policies: [], middlewares: [] },
    },
    {
      method: "GET",
      path: "/blocks/status/:userId",
      handler: "block.blockStatus",
      config: { policies: [], middlewares: [] },
    },
    {
      method: "GET",
      path: "/blocks/my-blocks",
      handler: "block.myBlocks",
      config: { policies: [], middlewares: [] },
    },
  ],
};