import { Server } from "socket.io";

declare module "@strapi/strapi" {
  interface Strapi {
    io?: Server;
  }
}
