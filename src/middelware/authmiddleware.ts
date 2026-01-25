// middlewares/socketAuth.ts
import type { Socket } from "socket.io"
import jwt from "jsonwebtoken"

interface JwtPayload {
   userId: number;
  iat?: number;
  exp?: number;
  //role :for later
}

export default async function socketAuth(
  socket: Socket,
  next: (err?: Error) => void
) {
  try {
    const token = socket.handshake.auth.token ? socket.handshake.auth.token : socket.handshake.headers.token;

    if (!token) {
      return next(new Error("UNAUTHORIZED"))
    }

    const payload = jwt.verify(
      token,
      process.env.JWT_SECRET!
    ) as JwtPayload

    socket.data.user = {
      id: payload.userId,
     //role:later
    }

    next()
  } catch (err) {
    next(new Error("UNAUTHORIZED"))
  }
}
