const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // ✅ Allow all (or replace with your Netlify domain for security)
    methods: ["GET", "POST"]
  }
});

// 🔹 Replace with your real values
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const MONGO_URI = process.env.MONGO_URI;

// Connect MongoDB
mongoose.connect(MONGO_URI, {})
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => console.error("MongoDB Error:", err));

// Chat Schema
const messageSchema = new mongoose.Schema({
  userId: String,
  name: String,
  from: String,
  text: String,
  time: { type: Date, default: Date.now }
});
const Message = mongoose.model("Message", messageSchema);

// Active users
let users = {};
let pendingReplies = {}; // store mapping admin ↔ user being replied

// Telegram bot
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Socket.io
io.on('connection', socket => {
  const userName = socket.handshake.query.name;
  const userId = socket.handshake.query.userId; // ✅ persistent id from frontend

  users[userId] = { name: userName, socketId: socket.id };

  console.log(`${userName} (${userId}) connected`);

  // Load chat history for this user
  Message.find({ userId }).sort({ time: 1 }).then(history => {
    history.forEach(msg => {
      io.to(socket.id).emit('chat', {
        from: msg.from === "Admin" ? "Harvestive Manager" : msg.from,
        text: msg.text,
        time: msg.time
      });
    });
  });

  // On user message
  socket.on('message', async msg => {
    const messageData = new Message({
      userId,
      name: userName,
      from: userName,
      text: msg.text
    });
    await messageData.save();

    // Step 1: Acknowledge "sent" ✔
    io.to(socket.id).emit("status", {
      text: msg.text,
      status: "sent",
      time: new Date()
    });

    // Send to Telegram with reply button
    bot.sendMessage(
      ADMIN_CHAT_ID,
      `👤 <b>${userName}</b>\n🆔 ${userId}\n💬 ${msg.text}`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: `Reply to ${userName}`, callback_data: `reply:${userId}` }]
          ]
        }
      }
    ).then(() => {
      // Step 2: Mark "delivered" ✔✔
      io.to(socket.id).emit("status", {
        text: msg.text,
        status: "delivered",
        time: new Date()
      });
    }).catch(err => console.error("Telegram Error:", err));
  });

  socket.on('disconnect', () => {
    console.log(`${userName} (${userId}) disconnected`);
  });
});

// Handle inline button clicks
bot.on("callback_query", async callbackQuery => {
  const data = callbackQuery.data;
  bot.answerCallbackQuery(callbackQuery.id); // ✅ stop the shining spinner

  if (data.startsWith("reply:")) {
    const userId = data.split(":")[1];
    const user = users[userId];

    // Save pending reply state
    pendingReplies[callbackQuery.message.chat.id] = userId;

    // Ask admin for reply with forceReply
    bot.sendMessage(
      callbackQuery.message.chat.id,
      `✍️ Reply to <b>${user ? user.name : "User"}</b>:`,
      {
        parse_mode: "HTML",
        reply_markup: { force_reply: true }
      }
    );
  }
});

// Handle admin replies
bot.on("message", async msg => {
  const adminId = msg.chat.id;

  // If this is a reply triggered by forceReply
  if (pendingReplies[adminId] && msg.text && !msg.text.startsWith("/")) {
    const userId = pendingReplies[adminId];
    const replyText = msg.text;

    if (users[userId]) {
      io.to(users[userId].socketId).emit('chat', {
        from: "Harvestive Manager", // ✅ show custom admin name
        text: replyText,
        time: new Date()
      });

      const messageData = new Message({
        userId,
        name: users[userId].name,
        from: "Harvestive Manager",
        text: replyText
      });
      await messageData.save();

      bot.sendMessage(adminId, `✅ Sent to ${users[userId].name}`);
    } else {
      bot.sendMessage(adminId, "⚠️ User not found or disconnected.");
    }

    // Clear pending reply
    delete pendingReplies[adminId];
  }
});

// ❌ Removed app.use(express.static(...)) so backend doesn’t serve frontend

server.listen(3000, () =>
  console.log("🚀 Backend running at http://localhost:3000")
);