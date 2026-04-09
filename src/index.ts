import dotenv from "dotenv";
import { createServer } from "http";
import { Server, type Socket } from "socket.io";
import socketAuth from "./middelware/authmiddleware";
import { redis } from "./redis/redis";

dotenv.config();

const httpServer = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Socket server is running");
});

type Location = {
  lat: number;
  lng: number;
  ts: number;
};

type SessionMode = 'normal' | 'ghost' | 'private';

type ActiveUserSession = {
  sessionId: number;
  sockets: Set<string>;
  location: Location | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  disconnectedAt: number | null;
  paused: boolean;
  sessionMode: SessionMode;
  avatarUrl: string;
  pathBuffer: Location[];
  flushTimer: ReturnType<typeof setInterval> | null;
};

function isStealthMode(mode: SessionMode): boolean {
  return mode === 'ghost' || mode === 'private';
}

const SESSION_RESUME_WINDOW_MS = Number(
  process.env.SESSION_RESUME_WINDOW_MS ?? 172_800_000, // 48 hours
);

const REDIS_TTL_SECONDS = 60 * 60 * 48; // 48 hours
const FLUSH_INTERVAL_MS = Number(process.env.FLUSH_INTERVAL_MS ?? 10_000); // 10 seconds

const activeUsersByRoom = new Map<string, Map<number, ActiveUserSession>>();
const activeBySocket = new Map<
  string,
  { roomId: string; userId: number; sessionId: number; sessionMode: SessionMode }
>();

function getOrCreateRoomMap(roomId: string) {
  if (!activeUsersByRoom.has(roomId)) {
    activeUsersByRoom.set(roomId, new Map());
  }
  return activeUsersByRoom.get(roomId)!;
}

function clearReconnectTimer(userData: ActiveUserSession) {
  if (userData.reconnectTimer) {
    clearTimeout(userData.reconnectTimer);
    userData.reconnectTimer = null;
  }
}

function clearFlushTimer(userData: ActiveUserSession) {
  if (userData.flushTimer) {
    clearInterval(userData.flushTimer);
    userData.flushTimer = null;
  }
}

/**
 * Flush the in-memory path buffer to Redis in a single RPUSH.
 * Called by the flush timer (every 10s), on end-session, and on disconnect.
 */
async function flushPathBuffer(sessionId: number, userData: ActiveUserSession) {
  if (userData.pathBuffer.length === 0) return;

  // Drain the buffer into a local copy so new points can accumulate during the flush
  const points = userData.pathBuffer.splice(0);

  try {
    const serialized = points.map((p) => JSON.stringify(p));
    await redis.rpush(`session:${sessionId}:path`, ...serialized);
  } catch (err) {
    console.error(`[Flush] Failed to flush ${points.length} points for session ${sessionId}:`, err);
    // Put points back at the front of the buffer so they aren't lost
    userData.pathBuffer.unshift(...points);
  }
}

/**
 * Start the periodic flush timer for a session.
 * Also sets the Redis key TTL on start (only once, not every flush).
 */
async function startFlushTimer(sessionId: number, userData: ActiveUserSession) {
  if (userData.flushTimer) return; // already running

  // Set TTL once when the timer starts (key may or may not exist yet — EXPIRE is safe either way)
  try {
    await redis.expire(`session:${sessionId}:path`, REDIS_TTL_SECONDS);
  } catch {
    // Non-critical, TTL will be set on next opportunity
  }

  userData.flushTimer = setInterval(async () => {
    await flushPathBuffer(sessionId, userData);

    // Refresh TTL periodically (every flush) to keep the key alive during long sessions
    try {
      await redis.expire(`session:${sessionId}:path`, REDIS_TTL_SECONDS);
    } catch {
      // Non-critical
    }
  }, FLUSH_INTERVAL_MS);
}

function scheduleSessionCleanup(
  roomId: string,
  userId: number,
  userData: ActiveUserSession,
) {
  clearReconnectTimer(userData);
  userData.disconnectedAt = Date.now();

  // Flush any buffered points before entering grace period
  flushPathBuffer(userData.sessionId, userData).catch((err) => {
    console.error(`[Flush] Error flushing on disconnect for user ${userId}:`, err);
  });

  // Stop the flush timer — no new points will arrive while disconnected
  clearFlushTimer(userData);

  userData.reconnectTimer = setTimeout(() => {
    finalizeSession(roomId, userId);
  }, SESSION_RESUME_WINDOW_MS);
}

function finalizeSession(roomId: string, userId: number) {
  const roomMap = activeUsersByRoom.get(roomId);
  const userData = roomMap?.get(userId);
  if (!roomMap || !userData) return;

  clearReconnectTimer(userData);
  clearFlushTimer(userData);

  // Final flush — ensure any remaining buffered points are written to Redis
  flushPathBuffer(userData.sessionId, userData).catch((err) => {
    console.error(`[Flush] Error on finalizeSession for user ${userId}:`, err);
  });

  for (const socketId of userData.sockets) {
    activeBySocket.delete(socketId);
    io.sockets.sockets.get(socketId)?.leave(`room:${roomId}`);
  }

  roomMap.delete(userId);
  if (roomMap.size === 0) {
    activeUsersByRoom.delete(roomId);
  }

  if (!isStealthMode(userData.sessionMode)) {
    io.to(`room:${roomId}`).emit("user:offline", { userId });
  }
}

function detachSocket(socketId: string) {
  const active = activeBySocket.get(socketId);
  if (!active) return;

  const roomMap = activeUsersByRoom.get(active.roomId);
  const userData = roomMap?.get(active.userId);

  if (userData) {
    userData.sockets.delete(socketId);
    if (userData.sockets.size === 0) {
      // Immediately tell the room this user is offline (marker should be removed)
      if (!isStealthMode(userData.sessionMode)) {
        io.to(`room:${active.roomId}`).emit("user:offline", { userId: active.userId });
      }
      scheduleSessionCleanup(active.roomId, active.userId, userData);
    }
  }

  activeBySocket.delete(socketId);
}

async function attachSocketToSession(
  socket: Socket,
  roomId: string,
  userId: number,
  sessionId: number,
  sessionMode: SessionMode = 'normal',
) {
  const previous = activeBySocket.get(socket.id);
  if (previous) {
    const previousRoomMap = activeUsersByRoom.get(previous.roomId);
    const previousUserData = previousRoomMap?.get(previous.userId);

    if (previousUserData) {
      previousUserData.sockets.delete(socket.id);
      if (previousUserData.sockets.size === 0) {
        scheduleSessionCleanup(
          previous.roomId,
          previous.userId,
          previousUserData,
        );
      }
    }

    activeBySocket.delete(socket.id);
  }

  const roomMap = getOrCreateRoomMap(roomId);
  const existing = roomMap.get(userId);
  const wasDisconnected = existing?.disconnectedAt !== null && existing?.disconnectedAt !== undefined;

  // Only fetch avatar from Redis when creating a NEW session entry
  let avatarUrl = existing?.avatarUrl ?? '';
  if (!existing) {
    try {
      avatarUrl = (await redis.get(`user:${userId}:avatar`)) ?? '';
    } catch (err) {
      console.error(`[Avatar] Failed to fetch avatar for user ${userId}:`, err);
    }
  }

  const userData = existing ?? {
    sessionId,
    sockets: new Set<string>(),
    location: null,
    reconnectTimer: null,
    disconnectedAt: null,
    paused: false,
    sessionMode,
    avatarUrl,
    pathBuffer: [],
    flushTimer: null,
  };

  clearReconnectTimer(userData);
  userData.sessionId = sessionId;
  userData.disconnectedAt = null;
  userData.paused = false;
  userData.sessionMode = sessionMode;
  userData.sockets.add(socket.id);
  roomMap.set(userId, userData);

  socket.join(`room:${roomId}`);
  activeBySocket.set(socket.id, { roomId, userId, sessionId, sessionMode });

  // Restart the flush timer if it was stopped during disconnect
  await startFlushTimer(sessionId, userData);

  // If user was disconnected/offline and is now reconnecting, tell the room they're back
  // Use socket.to() to exclude sender (prevents self-marker), skip for stealth modes
  if (wasDisconnected && userData.location && !isStealthMode(userData.sessionMode)) {
    socket.to(`room:${roomId}`).emit("user:online", {
      userId,
      ...userData.location,
      avatarUrl: userData.avatarUrl,
    });
  }
}

function getActiveUserSession(roomId: string, userId: number) {
  return activeUsersByRoom.get(roomId)?.get(userId) ?? null;
}

const io = new Server(httpServer, {});
io.use(socketAuth);

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  const userId = socket.data.user?.id;
  if (!userId) {
    socket.disconnect(true);
    return;
  }

  socket.on("join-room", (roomId: string) => {
    if (!roomId) return;

    socket.join(`room:${roomId}`);

    const roomMap = activeUsersByRoom.get(roomId);
    const snapshot = roomMap
      ? Array.from(roomMap.entries())
        .filter(([, data]) => data.sockets.size > 0 && data.disconnectedAt === null && !data.paused && !isStealthMode(data.sessionMode))
        .map(([uid, data]) =>
          data.location ? { userId: uid, ...data.location, avatarUrl: data.avatarUrl } : null,
        )
        .filter(Boolean)
      : [];

    socket.emit("location:snapshot", snapshot);
  });

  socket.on("start-session", ({ roomId, sessionId, sessionMode }) => {
    if (!roomId || !sessionId) return;
    const mode: SessionMode = (sessionMode === 'ghost' || sessionMode === 'private') ? sessionMode : 'normal';
    attachSocketToSession(socket, roomId, userId, Number(sessionId), mode);
  });

  // Frontend reconnect event: verify user is still active in room, then rebind socket and restore location state.
  socket.on("reconnect-session", async ({ roomId, sessionId }) => {
    if (!roomId) {
      socket.emit("session:resume-failed", { reason: "room-missing" });
      return;
    }

    const userData = getActiveUserSession(roomId, userId);
    if (!userData) {
      socket.emit("session:resume-failed", { reason: "not-active" });
      return;
    }

    if (sessionId && Number(sessionId) !== userData.sessionId) {
      socket.emit("session:resume-failed", { reason: "session-mismatch" });
      return;
    }

    attachSocketToSession(socket, roomId, userId, userData.sessionId, userData.sessionMode);

    socket.emit("session:resumed", {
      roomId,
      sessionId: userData.sessionId,
      location: userData.location,
      disconnectedAt: userData.disconnectedAt,
    });
  });

  // Frontend sends buffered locations collected while disconnected
  socket.on(
    "location:sync-buffered",
    async ({ locations }: { locations: Array<{ lat: number; lng: number; ts: number }> }) => {
      const active = activeBySocket.get(socket.id);
      if (!active) return;

      if (!Array.isArray(locations) || locations.length === 0) return;

      const roomMap = activeUsersByRoom.get(active.roomId);
      if (!roomMap) return;

      const userData = roomMap.get(active.userId);
      if (!userData) return;

      // Filter out locations the server already has (deduplicate by timestamp)
      const lastKnownTs = userData.location?.ts ?? 0;
      const newLocations = locations.filter((loc) => loc.ts > lastKnownTs);
      if (newLocations.length === 0) {
        socket.emit("location:sync-ack", { count: 0 });
        return;
      }

      // Remove consecutive duplicates (same lat/lng as previous point)
      const deduped: typeof newLocations = [];
      let prevLat = userData.location?.lat;
      let prevLng = userData.location?.lng;
      for (const loc of newLocations) {
        if (loc.lat !== prevLat || loc.lng !== prevLng) {
          deduped.push(loc);
          prevLat = loc.lat;
          prevLng = loc.lng;
        }
      }
      if (deduped.length === 0) {
        socket.emit("location:sync-ack", { count: 0 });
        return;
      }

      // Sync-buffered writes directly to Redis (already a single batch from the frontend)
      const pipeline = redis.multi();
      for (const loc of deduped) {
        const point: Location = { lat: loc.lat, lng: loc.lng, ts: loc.ts };
        pipeline.rpush(`session:${active.sessionId}:path`, JSON.stringify(point));
      }
      pipeline.expire(`session:${active.sessionId}:path`, REDIS_TTL_SECONDS);

      await pipeline.exec();

      // Update in-memory last location with the final deduplicated point
      const lastPoint = deduped[deduped.length - 1]!;
      userData.location = {
        lat: lastPoint.lat,
        lng: lastPoint.lng,
        ts: lastPoint.ts,
      };
 
      socket.emit("location:sync-ack", { count: deduped.length });
 
      if (!isStealthMode(active.sessionMode)) {
        socket.to(`room:${active.roomId}`).emit("location:update", {
          userId: active.userId,
          ...userData.location,
          avatarUrl: userData.avatarUrl,
        });
      }
    },
  );

  socket.on("location:update", ({ lat, lng }) => {
    const active = activeBySocket.get(socket.id);
    if (!active) return;

    const roomMap = activeUsersByRoom.get(active.roomId);
    if (!roomMap) return;

    const userData = roomMap.get(active.userId);
    if (!userData) return;
 
    if (userData.paused) return;

    // Skip if location is identical to the last known position
    if (userData.location && userData.location.lat === lat && userData.location.lng === lng) return;

    const point: Location = { lat, lng, ts: Date.now() };
    userData.location = point;

    // Push to in-memory buffer (flushed to Redis every FLUSH_INTERVAL_MS)
    userData.pathBuffer.push(point);

    // Broadcast to room immediately (real-time markers are unaffected by buffering)
    if (!isStealthMode(active.sessionMode)) {
      socket.to(`room:${active.roomId}`).emit("location:update", {
        userId: active.userId,
        ...point,
        avatarUrl: userData.avatarUrl,
      });
    }
  });
 
  socket.on("session:pause", () => {
    const active = activeBySocket.get(socket.id);
    if (!active) return;

    const roomMap = activeUsersByRoom.get(active.roomId);
    if (!roomMap) return;

    const userData = roomMap.get(active.userId);
    if (!userData) return;

    // Already paused — no-op, but still acknowledge
    if (userData.paused) {
      socket.emit("session:paused", { sessionId: active.sessionId });
      return;
    }

    userData.paused = true;

    // Broadcast offline to the room so markers are removed (skip for stealth modes)
    // Use socket.to() to exclude sender (prevents self receiving user:offline)
    if (!isStealthMode(userData.sessionMode)) {
      socket.to(`room:${active.roomId}`).emit("user:offline", { userId: active.userId });
    }

    // Acknowledge back to the user
    socket.emit("session:paused", { sessionId: active.sessionId });
  });
 
  socket.on("session:resume", () => {
    const active = activeBySocket.get(socket.id);
    if (!active) return;

    const roomMap = activeUsersByRoom.get(active.roomId);
    if (!roomMap) return;

    const userData = roomMap.get(active.userId);
    if (!userData) return;

    // Not paused — no-op, but still acknowledge
    if (!userData.paused) {
      socket.emit("session:resumed-active", { sessionId: active.sessionId });
      return;
    }

    userData.paused = false;

    // If the user had a last known location, broadcast online immediately (skip for stealth modes)
    // Use socket.to() to exclude sender (prevents self-marker appearing on resume)
    if (userData.location && !isStealthMode(userData.sessionMode)) {
      socket.to(`room:${active.roomId}`).emit("user:online", {
        userId: active.userId,
        ...userData.location,
        avatarUrl: userData.avatarUrl,
      });
    }

    // Acknowledge back to the user
    socket.emit("session:resumed-active", { sessionId: active.sessionId });
  });

  socket.on("end-session", async () => {
    const active = activeBySocket.get(socket.id);
    if (!active) return;

    // Flush buffered points to Redis before finalizing
    const roomMap = activeUsersByRoom.get(active.roomId);
    const userData = roomMap?.get(active.userId);
    if (userData) {
      await flushPathBuffer(active.sessionId, userData);
      clearFlushTimer(userData);
    }

    finalizeSession(active.roomId, active.userId);
  });

  const handleDiscardSession = async () => {
    const active = activeBySocket.get(socket.id);
    if (!active) return;

    // Clear the buffer WITHOUT flushing — data is being thrown away
    const roomMap = activeUsersByRoom.get(active.roomId);
    const userData = roomMap?.get(active.userId);
    if (userData) {
      userData.pathBuffer.length = 0;
      clearFlushTimer(userData);
    }

    try { 
      await redis
        .multi()
        .del(`session:${active.sessionId}:path`)
        .del(`user:${active.userId}:avatar`)
        .exec();
    } catch (error) {
      console.error("Error deleting session data from Redis:", error);
    }

    // Remove the user from active tracking and notify others
    finalizeSession(active.roomId, active.userId);
  };

  socket.on("discard-session", handleDiscardSession);
  socket.on("discard-sesion", handleDiscardSession);

  socket.on("disconnect", () => {
    detachSocket(socket.id);
  });
});

const HOST = "0.0.0.0";
const PORT = 3000;

httpServer.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
  console.log(`Access from other devices using your local IP (port:${PORT})`);
});
