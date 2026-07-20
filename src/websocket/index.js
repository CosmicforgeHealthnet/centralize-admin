const { Server } = require("socket.io");
const SupportChatSocket = require("./supportChat.socket");

let ioInstance = null;

const initializeWebSocket = (httpServer) => {
  const allowedOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(",").map((o) => o.trim())
    : ["http://localhost:3000"];

  const io = new Server(httpServer, {
    cors: {
      origin: allowedOrigins,
      methods: ["GET", "POST"],
      credentials: true,
    },
    path: "/socket.io", // default path
  });

  // Namespace for support chat
  const supportNamespace = io.of("/support");
  const supportChat = new SupportChatSocket(supportNamespace);
  supportChat.initialize();

  ioInstance = io;

  return io;
};

const emitAdminNotification = (adminUserId, payload) => {
  if (!ioInstance) return false;
  ioInstance.to(`admin:${adminUserId}`).emit("notification:new", payload);
  return true;
};

module.exports = { initializeWebSocket, emitAdminNotification };
