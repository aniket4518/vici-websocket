"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const socket_io_client_1 = require("socket.io-client");
const socket = (0, socket_io_client_1.io)("http://localhost:3000", {
    transports: ["websocket"],
});
socket.on("connect", () => {
    console.log("✅ Connected to server");
    console.log("Socket ID:", socket.id);
    socket.emit("ping-test", "ping from TS client");
});
socket.on("pong-test", (msg) => {
    console.log("🎉 Server replied:", msg);
    socket.disconnect();
});
socket.on("connect_error", (err) => {
    console.error("❌ Connection error:", err.message);
});
//# sourceMappingURL=test-server.js.map