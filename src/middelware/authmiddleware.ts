import { verifyToken } from "@clerk/backend";
import type { Socket } from "socket.io";
import { prisma } from "../config/prisma";

export default async function socketAuth(
  socket: Socket,
  next: (err?: Error) => void
) {
  try {
    const token = socket.handshake.auth.token || socket.handshake.headers.token;

    if (!token || typeof token !== "string") {
      return next(new Error("UNAUTHORIZED"));
    }

    // Clerk verifies signature, expiry, and issuer automatically (RS256)
    const clerkPayload = await verifyToken(token, {
      secretKey: process.env.CLERK_SECRET_KEY!,
    });

    // Look up local user by Clerk's user ID (the `sub` claim) to get numeric DB id
    const user = await prisma.user.findUnique({
      where: { clerkId: clerkPayload.sub },
      select: { id: true },
    });

    if (!user) {
      return next(new Error("USER_NOT_SYNCED"));
    }

    // Preserve the same contract — socket.data.user.id is a number
    socket.data.user = { id: user.id };
    next();
  } catch (err) {
    console.error("Socket auth error:", err);
    next(new Error("UNAUTHORIZED"));
  }
}
