"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = socketAuth;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
async function socketAuth(socket, next) {
    try {
        const token = socket.handshake.auth?.token;
        if (!token) {
            return next(new Error("UNAUTHORIZED"));
        }
        const payload = jsonwebtoken_1.default.verify(token, process.env.JWT_SECRET);
        socket.data.user = {
            id: payload.userId,
            //role:later
        };
        next();
    }
    catch (err) {
        next(new Error("UNAUTHORIZED"));
    }
}
//# sourceMappingURL=authmiddleware.js.map