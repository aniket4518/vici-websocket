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

type ActiveUserSession = {
  sessionId: number;
  sockets: Set<string>;
  location: Location | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  disconnectedAt: number | null;
};

const SESSION_RESUME_WINDOW_MS = Number(
  process.env.SESSION_RESUME_WINDOW_MS ?? 172_800_000, // 48 hours
);

const REDIS_TTL_SECONDS = 60 * 60 * 48; // 48 hours

const activeUsersByRoom = new Map<string, Map<number, ActiveUserSession>>();
const activeBySocket = new Map<
  string,
  { roomId: string; userId: number; sessionId: number }
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

function scheduleSessionCleanup(
  roomId: string,
  userId: number,
  userData: ActiveUserSession,
) {
  clearReconnectTimer(userData);
  userData.disconnectedAt = Date.now();
  userData.reconnectTimer = setTimeout(() => {
    finalizeSession(roomId, userId);
  }, SESSION_RESUME_WINDOW_MS);
}

function finalizeSession(roomId: string, userId: number) {
  const roomMap = activeUsersByRoom.get(roomId);
  const userData = roomMap?.get(userId);
  if (!roomMap || !userData) return;

  clearReconnectTimer(userData);

  for (const socketId of userData.sockets) {
    activeBySocket.delete(socketId);
    io.sockets.sockets.get(socketId)?.leave(`room:${roomId}`);
  }

  roomMap.delete(userId);
  if (roomMap.size === 0) {
    activeUsersByRoom.delete(roomId);
  }

  io.to(`room:${roomId}`).emit("user:offline", { userId });
}

function detachSocket(socketId: string) {
  const active = activeBySocket.get(socketId);
  if (!active) return;

  const roomMap = activeUsersByRoom.get(active.roomId);
  const userData = roomMap?.get(active.userId);

  if (userData) {
    userData.sockets.delete(socketId);
    if (userData.sockets.size === 0) {
      scheduleSessionCleanup(active.roomId, active.userId, userData);
    }
  }

  activeBySocket.delete(socketId);
}

function attachSocketToSession(
  socket: Socket,
  roomId: string,
  userId: number,
  sessionId: number,
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
  const userData = roomMap.get(userId) ?? {
    sessionId,
    sockets: new Set<string>(),
    location: null,
    reconnectTimer: null,
    disconnectedAt: null,
  };

  clearReconnectTimer(userData);
  userData.sessionId = sessionId;
  userData.disconnectedAt = null;
  userData.sockets.add(socket.id);
  roomMap.set(userId, userData);

  socket.join(`room:${roomId}`);
  activeBySocket.set(socket.id, { roomId, userId, sessionId });
}

function getActiveUserSession(roomId: string, userId: number) {
  return activeUsersByRoom.get(roomId)?.get(userId) ?? null;
}

async function saveLastLocationToRedis(
  sessionId: number,
  userId: number,
  point: Location,
) {
  await redis
    .multi()
    .set(
      `session:${sessionId}:user:${userId}:last-location`,
      JSON.stringify(point),
      "EX",
      REDIS_TTL_SECONDS,
    )
    .exec();
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
        .map(([uid, data]) =>
          data.location ? { userId: uid, ...data.location } : null,
        )
        .filter(Boolean)
      : [];

    socket.emit("location:snapshot", snapshot);
  });

  socket.on("start-session", ({ roomId, sessionId }) => {
    if (!roomId || !sessionId) return;
    attachSocketToSession(socket, roomId, userId, Number(sessionId));
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

    attachSocketToSession(socket, roomId, userId, userData.sessionId);

    if (userData.location) {
      await saveLastLocationToRedis(
        userData.sessionId,
        userId,
        userData.location,
      );
    }

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

      // Pipeline all buffered points into Redis in one go
      const pipeline = redis.multi();
      for (const loc of locations) {
        const point: Location = { lat: loc.lat, lng: loc.lng, ts: loc.ts };
        pipeline.rpush(`session:${active.sessionId}:path`, JSON.stringify(point));
      }
      pipeline.expire(`session:${active.sessionId}:path`, REDIS_TTL_SECONDS);

      // Update last-location with the final buffered point
      const lastPoint = locations[locations.length - 1]!;
      const lastLocation: Location = {
        lat: lastPoint.lat,
        lng: lastPoint.lng,
        ts: lastPoint.ts,
      };
      pipeline.set(
        `session:${active.sessionId}:user:${active.userId}:last-location`,
        JSON.stringify(lastLocation),
        "EX",
        REDIS_TTL_SECONDS,
      );

      await pipeline.exec();

      // Update in-memory state
      userData.location = lastLocation;

      // Acknowledge to the sender
      socket.emit("location:sync-ack", { count: locations.length });

      // Broadcast the latest position to other users in the room
      socket.to(`room:${active.roomId}`).emit("location:update", {
        userId: active.userId,
        ...lastLocation,
      });
    },
  );

  socket.on("location:update", async ({ lat, lng }) => {
    const active = activeBySocket.get(socket.id);
    if (!active) return;

    const roomMap = activeUsersByRoom.get(active.roomId);
    if (!roomMap) return;

    const userData = roomMap.get(active.userId);
    if (!userData) return;

    const point: Location = { lat, lng, ts: Date.now() };
    userData.location = point;

    await redis
      .multi()
      .rpush(`session:${active.sessionId}:path`, JSON.stringify(point))
      .expire(`session:${active.sessionId}:path`, REDIS_TTL_SECONDS)
      .set(
        `session:${active.sessionId}:user:${active.userId}:last-location`,
        JSON.stringify(point),
        "EX",
        REDIS_TTL_SECONDS,
      )
      .exec();

    socket.to(`room:${active.roomId}`).emit("location:update", {
      userId: active.userId,
      ...point,
    });
  });

  socket.on("end-session", () => {
    const active = activeBySocket.get(socket.id);
    if (!active) return;
    finalizeSession(active.roomId, active.userId);
  });

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
