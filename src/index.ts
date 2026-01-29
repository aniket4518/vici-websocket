import dotenv from "dotenv";
dotenv.config();
import { createServer } from "http";
import { Server } from "socket.io";
import socketAuth from "./middelware/authmiddleware";
const httpServer = createServer();
type Location = {
  lat: number
  lng: number
  ts: number
}
 // roomId -> userId -> active session info
const activeUsersByRoom = new Map<
  string,
  Map<number, {
    sessionId: string
    sockets: Set<string>
    location: Location | null
  }>
>()

// socketId -> roomId + sessionId
const activeBySocket = new Map<
  string,
  { roomId: string; sessionId: string }
>()


const io = new Server(httpServer, {});
//authenticate the user
io.use(socketAuth);
io.on("connection", (socket) => {
  console.log("User connected:", socket.id);
  const userId = socket.data.user.id;
   socket.on("join-room", (roomId: string) => {
  if (!roomId) return

  socket.join(`room:${roomId}`)

  const roomMap = activeUsersByRoom.get(roomId)
  const snapshot = roomMap
    ? Array.from(roomMap.entries())
        .map(([uid, data]) =>
          data.location
            ? { userId: uid, ...data.location }
            : null
        )
        .filter(Boolean)
    : []

  socket.emit("location:snapshot", snapshot)
})

  socket.on("start-session", ({ roomId, sessionId }) => {
  const userId = socket.data.user.id
  if (!roomId || !sessionId) return

  if (!activeUsersByRoom.has(roomId)) {
    activeUsersByRoom.set(roomId, new Map())
  }

  const roomMap = activeUsersByRoom.get(roomId)!

  if (!roomMap.has(userId)) {
    roomMap.set(userId, {
      sessionId,
      sockets: new Set(),
      location: null,
    })
  }

  roomMap.get(userId)!.sockets.add(socket.id)
  activeBySocket.set(socket.id, { roomId, sessionId })
})

socket.on("location:update", ({ lat, lng }) => {
  const userId = socket.data.user.id
  const active = activeBySocket.get(socket.id)
  if (!active) return

  const { roomId } = active
  const roomMap = activeUsersByRoom.get(roomId)
  if (!roomMap) return

  const userData = roomMap.get(userId)
  if (!userData) return

  const point = { lat, lng, ts: Date.now() }
  userData.location = point

  socket.to(`room:${roomId}`).emit("location:update", {
    userId,
    ...point,
  })
})

   function cleanupSocket(socketId: string) {
  const active = activeBySocket.get(socketId)
  if (!active) return

  const { roomId } = active
  const roomMap = activeUsersByRoom.get(roomId)
  const userData = roomMap?.get(userId)

  if (userData) {
    userData.sockets.delete(socketId)

    if (userData.sockets.size === 0) {
      roomMap!.delete(userId)

      socket.to(`room:${roomId}`).emit("user:offline", { userId })
    }
  }

  activeBySocket.delete(socketId)
}

socket.on("end-session", () => cleanupSocket(socket.id))
socket.on("disconnect", () => cleanupSocket(socket.id))

});

 

const HOST = "0.0.0.0";
const PORT = 3000;

httpServer.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
  console.log(`Access from other devices using your local IP (port:${PORT})`);
});
