import dotenv from "dotenv";
dotenv.config();
import { createServer } from "http";
import { Server } from "socket.io";
import socketAuth from "./middelware/authmiddleware";
const httpServer = createServer();
const userSockets = new Map<number, Set<string>>()
const liveUsers = new Map<number, { lat: number; lng: number; ts: number }>()

const io = new Server(httpServer, {});
//authenticate the user
io.use(socketAuth);

io.on("connection", (socket) => {
  const userId = socket.data.user.id
  const socketId = socket.id

  // ── Ensure only ONE socket per user ─────────────
  const existingSockets = userSockets.get(userId)


    async function getAllSocketIds() {
    const sockets = await io.fetchSockets();
    
    console.log('All connected socket IDs:', sockets);
    return sockets;
  }

  // Example usage (e.g., after a new connection)
  getAllSocketIds();

  if (existingSockets) {
    for (const oldSocketId of existingSockets) {
      const oldSocket = io.sockets.sockets.get(oldSocketId)
      if (oldSocket) {
        oldSocket.disconnect(true)
      }
    }
  }

  // Register ONLY this socket
  userSockets.set(userId, new Set([socketId]))

  console.log(`user ${userId} connected with socket ${socketId}`)

  // ── Send snapshot of others ────────────────────
  const snapshot = Array.from(liveUsers.entries())
    .filter(([id]) => id !== userId)
    .map(([id, loc]) => ({ userId: id, ...loc }))

  socket.emit("location:snapshot", snapshot)

  // ── Handle location updates ────────────────────
  socket.on("location:update", ({ lat, lng }) => {
    if (
      typeof lat !== "number" ||
      typeof lng !== "number" ||
      lat < -90 ||
      lat > 90 ||
      lng < -180 ||
      lng > 180
    ) return

    const point = { lat, lng, ts: Date.now() }
    liveUsers.set(userId, point)

    socket.broadcast.emit("location:update", {
      userId,
      ...point,
    })
  })

  // ── Disconnect cleanup ─────────────────────────
  socket.on("disconnect", () => {
    const sockets = userSockets.get(userId)

    if (sockets && sockets.has(socketId)) {
      sockets.delete(socketId)
      if (sockets.size === 0) {
        userSockets.delete(userId)
        liveUsers.delete(userId)

        socket.broadcast.emit("user:offline", { userId })
        console.log(`user ${userId} disconnected`)
      }
    }
  })
   
});

//  function websocketconnection(){
// //token payload to verify
// try{
//   io.use(socketAuth)
//   //make socket io connection
//   io.on("connection", (socket) => {

//   const user = socket.data.user
//   console.log("connected:", user.id)
//   socket.on("location-update",({lat,lng})=>{
//     if (typeof lat !== "number" || typeof lng !== "number"){
//      return
//     }
//   })

//   socket.on("disconnect", () => {
//     console.log("disconnected:", user.id)
//   })

// })
//  }
//  catch(error){
//   console.error(`[WS] Error for user :`, error);
//  }
// }

const HOST = "0.0.0.0";
const PORT = 3000;

httpServer.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
  console.log(`Access from other devices using your local IP (port:${PORT})`);
});
//  socket.on("location-update",({lat,lng})=>{
//     if (typeof lat !== "number" || typeof lng !== "number"){
//      return
//     }
//   })
