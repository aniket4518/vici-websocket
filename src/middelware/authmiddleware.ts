import { verifyToken } from "@clerk/backend";
import type { Socket } from "socket.io";


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

    // Extract the custom claim we configured in the Clerk Dashboard
    const numericUserId = (clerkPayload as any).userId;

    // Optional: Also check standard `clerkPayload.sub` if somehow it's missing, but here
    // we strictly rely on the custom claim to avoid DB lookup.
    if (!numericUserId) {
      console.warn(`Missing 'userId' custom claim in Clerk token for sub: ${clerkPayload.sub}`);
      return next(new Error("USER_NOT_SYNCED"));
    }

    socket.data.user = { id: Number(numericUserId) };
    next();
  } catch (err) {
    console.error("Socket auth error:", err);
    next(new Error("UNAUTHORIZED"));
  }
}
