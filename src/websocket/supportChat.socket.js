const { mainPrisma } = require("../shared/config/mainDatabase");
const { prisma } = require("../shared/config/database");
const jwt = require("jsonwebtoken");

class SupportChatSocket {
  constructor(io) {
    this.io = io;
    this.onlineAgents = new Map(); // adminId -> socketId
  }

  initialize() {
    // Auth middleware — verify admin JWT
    this.io.use(async (socket, next) => {
      try {
        const token =
          socket.handshake.auth.token ||
          socket.handshake.headers.authorization?.replace("Bearer ", "");

        if (!token) return next(new Error("No token provided"));

        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        // Load admin from admin DB
        const admin = await prisma.adminUser.findUnique({
          where: { id: decoded.sub },
        });

        if (!admin || admin.status !== "ACTIVE") {
          return next(new Error("Unauthorized"));
        }

        socket.adminId = admin.id;
        socket.admin = admin;
        next();
      } catch (err) {
        next(new Error("Invalid token"));
      }
    });

    this.io.on("connection", (socket) => {
      console.log(`Admin agent connected: ${socket.admin.email}`);
      this.handleConnection(socket);
    });

    console.log("Support chat WebSocket initialized");
  }

  handleConnection(socket) {
    // Track agent
    this.onlineAgents.set(socket.adminId, socket.id);

    // Join a support chat room (to receive/send messages)
    socket.on("join_support_room", async (data) => {
      await this.handleJoinRoom(socket, data);
    });

    // Send message
    socket.on("send_support_message", async (data) => {
      await this.handleSendMessage(socket, data);
    });

    // Typing indicator
    socket.on("typing_start", (data) => {
      socket.to(data.roomId).emit("agent_typing", {
        agentId: socket.adminId,
        name: socket.admin.name,
        isTyping: true,
      });
    });

    socket.on("typing_stop", (data) => {
      socket.to(data.roomId).emit("agent_typing", {
        agentId: socket.adminId,
        isTyping: false,
      });
    });

    socket.on("disconnect", () => {
      console.log(`Admin agent disconnected: ${socket.admin.email}`);
      this.onlineAgents.delete(socket.adminId);
    });
  }

  async handleJoinRoom(socket, data) {
    try {
      const { roomId } = data;

      // Verify room exists and is support type
      const room = await mainPrisma.chat_rooms.findFirst({
        where: { id: roomId, type: "support", deletedAt: null },
      });

      if (!room) {
        return socket.emit("error", { message: "Room not found" });
      }

      socket.join(roomId);

      // Load last 50 messages
      const messages = await mainPrisma.chat_messages.findMany({
        where: { roomId, deleted: false },
        include: {
          sender: {
            select: {
              id: true,
              fullName: true,
              profileImageUrl: true,
              role: true,
            },
          },
        },
        orderBy: { createdAt: "asc" },
        take: 50,
      });

      socket.emit("room_joined", { roomId, messages });
    } catch (err) {
      console.error("handleJoinRoom error:", err);
      socket.emit("error", { message: err.message });
    }
  }

  async handleSendMessage(socket, data) {
    try {
      const { roomId, content } = data;

      if (!content?.trim()) {
        return socket.emit("error", { message: "Content is required" });
      }

      if (!socket.admin.mainAppUserId) {
        return socket.emit("error", {
          message: "Your account is not linked to the main app",
        });
      }

      // Verify agent is a participant (has claimed this chat)
      const participant = await mainPrisma.chat_participants.findFirst({
        where: {
          roomId,
          userId: socket.admin.mainAppUserId,
          isActive: true,
        },
      });

      if (!participant) {
        return socket.emit("error", {
          message: "Claim this chat first before sending messages",
        });
      }

      // Save to DB
      const message = await mainPrisma.chat_messages.create({
        data: {
          roomId,
          senderId: socket.admin.mainAppUserId,
          content: content.trim(),
          type: "text",
        },
        include: {
          sender: {
            select: {
              id: true,
              fullName: true,
              profileImageUrl: true,
              role: true,
            },
          },
        },
      });

      // Emit to everyone in the room (including sender for confirmation)
      this.io.to(roomId).emit("new_support_message", message);
    } catch (err) {
      console.error("handleSendMessage error:", err);
      socket.emit("error", { message: err.message });
    }
  }
}

module.exports = SupportChatSocket;
