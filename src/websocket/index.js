const { Server } = require("socket.io");
const SupportChatSocket = require("./supportChat.socket");

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

  return io;
};

module.exports = { initializeWebSocket };
