"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const http_1 = require("http");
const socket_io_1 = require("socket.io");
const authmiddleware_1 = __importDefault(require("./middelware/authmiddleware"));
const httpServer = (0, http_1.createServer)();
const userSockets = new Map();
const liveUsers = new Map();
const io = new socket_io_1.Server(httpServer, {});
//authenticate the user
io.use(authmiddleware_1.default);
io.on("connection", (socket) => {
    const userId = socket.data.user.id;
    const socketId = socket.id;
    // ── Ensure only ONE socket per user ─────────────
    const existingSockets = userSockets.get(userId);
    if (existingSockets) {
        for (const oldSocketId of existingSockets) {
            const oldSocket = io.sockets.sockets.get(oldSocketId);
            if (oldSocket) {
                oldSocket.disconnect(true);
            }
        }
    }
    // Register ONLY this socket
    userSockets.set(userId, new Set([socketId]));
    console.log(`user ${userId} connected with socket ${socketId}`);
    // ── Send snapshot of others ────────────────────
    const snapshot = Array.from(liveUsers.entries())
        .filter(([id]) => id !== userId)
        .map(([id, loc]) => ({ userId: id, ...loc }));
    socket.emit("location:snapshot", snapshot);
    // ── Handle location updates ────────────────────
    socket.on("location:update", ({ lat, lng }) => {
        if (typeof lat !== "number" ||
            typeof lng !== "number" ||
            lat < -90 ||
            lat > 90 ||
            lng < -180 ||
            lng > 180)
            return;
        const point = { lat, lng, ts: Date.now() };
        liveUsers.set(userId, point);
        socket.broadcast.emit("location:update", {
            userId,
            ...point,
        });
    });
    // ── Disconnect cleanup ─────────────────────────
    socket.on("disconnect", () => {
        const sockets = userSockets.get(userId);
        if (sockets && sockets.has(socketId)) {
            sockets.delete(socketId);
            if (sockets.size === 0) {
                userSockets.delete(userId);
                liveUsers.delete(userId);
                socket.broadcast.emit("user:offline", { userId });
                console.log(`user ${userId} disconnected`);
            }
        }
    });
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
httpServer.listen(3000);
//  socket.on("location-update",({lat,lng})=>{
//     if (typeof lat !== "number" || typeof lng !== "number"){
//      return
//     }
//   })
//# sourceMappingURL=index.js.map