import dotenv from "dotenv";
dotenv.config();
import { createServer } from "http";
import { Server } from "socket.io";
import socketAuth from "./middelware/authmiddleware";
const httpServer = createServer();
const rooms: Record<
  string,
  Record<string, { userId: string; location: any }>
> = {};

const io = new Server(httpServer, {});
//authenticate the user
io.use(socketAuth);
io.on("connection", (socket) => {
  console.log("User connected:", socket.id);
  const userId = socket.data.user.id;
  socket.on("start-session", ({ roomId }, userId) => {
    socket.join(roomId);

    // Init room if not exists
    if (!rooms[roomId]) {
      rooms[roomId] = {};
    }

    rooms[roomId][socket.id] = {
      userId,
      location: null,
    };

    // Send existing users' locations to the new user
    socket.emit("room-users", rooms[roomId]);

    console.log(`${socket.id} joined room ${roomId}`);
  });
  socket.on("location-update", ({ roomId, lat, lng }) => {
    // Save location
    if (!rooms[roomId] || !rooms[roomId][socket.id]) return;
    rooms[roomId][socket.id]!.location = { lat, lng };

    // Send updated locations to everyone in the room
    io.to(roomId).emit("location-update", {
      socketId: socket.id,
      location: { lat, lng },
    });
  });
socket.on("end-session", () => {
    socket.disconnect(true);
})
  socket.on("disconnect", () => {
    for (const roomId in rooms) {
      if (rooms[roomId] && rooms[roomId][socket.id]) {
        delete rooms[roomId][socket.id];

        // Notify room user left
        io.to(roomId).emit("user-left", userId);

        // Clean empty room
        if (rooms[roomId] && Object.keys(rooms[roomId]!).length === 0) {
          delete rooms[roomId];
        }
      }
    }

    console.log("User disconnected:", socket.id);
  });
});

// io.local.socketsJoin("room1");
// io.on("connection", (socket) => {
//   const userId = socket.data.user.id
//   const socketId = socket.id

//   const existingSockets = userSockets.get(userId)

//   if (existingSockets) {
//     for (const oldSocketId of existingSockets) {
//       const oldSocket = io.sockets.sockets.get(oldSocketId)
//       if (oldSocket) {
//         oldSocket.disconnect(true)
//       }
//     }
//   }

//   // Register ONLY this socket
//   userSockets.set(userId, new Set([socketId]))

//   console.log(`user ${userId} connected with socket ${socketId}`)

//   // ── Send snapshot of others ────────────────────
//   const snapshot = Array.from(liveUsers.entries())
//     .filter(([id]) => id !== userId)
//     .map(([id, loc]) => ({ userId: id, ...loc }))

//   socket.emit("location:snapshot", snapshot)

//   // ── Handle location updates ────────────────────
//   socket.on("location:update", ({ lat, lng }) => {
//     if (
//       typeof lat !== "number" ||
//       typeof lng !== "number" ||
//       lat < -90 ||
//       lat > 90 ||
//       lng < -180 ||
//       lng > 180
//     ) return

//     const point = { lat, lng, ts: Date.now() }
//     liveUsers.set(userId, point)

//     socket.broadcast.emit("location:update", {
//       userId,
//       ...point,
//     })
//   })
//     socket.on("session-end",()=>{
//       socket.disconnect(true)
//     })
//   socket.on("disconnect", () => {
//     const sockets = userSockets.get(userId)

//     if (sockets && sockets.has(socketId)) {
//       sockets.delete(socketId)
//       if (sockets.size === 0) {
//         userSockets.delete(userId)
//         liveUsers.delete(userId)

//         socket.broadcast.emit("user:offline", { userId })
//         console.log(`user ${userId} disconnected`)
//       }
//     }
//   })

// });

const HOST = "0.0.0.0";
const PORT = 3000;

httpServer.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
  console.log(`Access from other devices using your local IP (port:${PORT})`);
});
