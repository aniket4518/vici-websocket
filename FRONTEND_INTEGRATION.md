# 🏃 Vici WebSocket Server — Complete API Documentation

> Real-time multi-user location tracking for the Vici running app

---

## 📖 Table of Contents

- [Overview](#-overview)
- [Tech Stack](#-tech-stack)
- [Environment Variables](#-environment-variables)
- [Connection & Authentication](#-connection--authentication)
- [User Flow](#-user-flow)
- [Client → Server Events](#-client--server-events)
- [Server → Client Events](#-server--client-events)
- [Events Summary Table](#-events-summary-table)
- [Redis Data Model](#-redis-data-model)
- [In-Memory Data Structures](#-in-memory-data-structures)
- [Session Reconnection Flow](#-session-reconnection-flow)
- [Connection State Diagram](#-connection-state-diagram)
- [TypeScript Types (All)](#-typescript-types-all)
- [Complete Frontend Implementation Example](#-complete-frontend-implementation-example)
- [Important Notes](#-important-notes)
- [Server Information](#-server-information)

---

## 📖 Overview

This WebSocket server (built with **Socket.IO**) enables real-time location sharing between users during running sessions. Users can:

- **Connect & Join Rooms** — Authenticate via JWT and join a tracking room
- **View Other Runners** — See all currently active users on a map in real-time
- **Start Sessions** — Begin a running session to share location with others
- **Track Their Path** — Location updates are stored both locally (client) and in Redis (server)
- **Reconnect Sessions** — Resume a session within a 30-second grace window after disconnect
- **End Sessions** — Stop sharing location when finished running

---

## 🛠️ Tech Stack

| Technology | Purpose |
|------------|---------|
| **Node.js** + **TypeScript** | Server runtime & language |
| **Socket.IO v4** | WebSocket communication |
| **ioredis** | Redis client for data persistence |
| **jsonwebtoken** | JWT-based authentication |
| **dotenv** | Environment variable management |
| **Docker** | Containerized deployment |

---

## 🔐 Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `JWT_SECRET` | ✅ Yes | — | Secret key used to verify JWT tokens |
| `REDIS_URL` | ❌ No | `localhost:6379` | Redis connection URL (supports `redis://` and `rediss://` for TLS) |
| `SESSION_RESUME_WINDOW_MS` | ❌ No | `30000` (30s) | Time (in ms) a disconnected session stays alive before cleanup |

**.env.example:**

```env
REDIS_URL=redis://something:password@host:port/db
JWT_SECRET=your-secret-key
SESSION_RESUME_WINDOW_MS=30000
```

---

## 🔌 Connection & Authentication

### Endpoint

```
ws://YOUR_SERVER_HOST:3000
```

An HTTP health check is also available at the same URL:

```
GET http://YOUR_SERVER_HOST:3000
→ 200 OK — "Socket server is running"
```

### Authentication

The server requires **JWT authentication** during the WebSocket handshake. Provide the token in one of two ways:

```typescript
// Option 1: Via auth object (recommended)
const socket = io("ws://YOUR_SERVER_HOST:3000", {
  auth: {
    token: "your-jwt-token"
  }
});

// Option 2: Via headers
const socket = io("ws://YOUR_SERVER_HOST:3000", {
  transportOptions: {
    websocket: {
      extraHeaders: {
        token: "your-jwt-token"
      }
    }
  }
});
```

### JWT Token Payload

The JWT must contain a `userId` field:

```typescript
interface JwtPayload {
  userId: number;   // Required — unique user identifier
  iat?: number;     // Issued-at timestamp
  exp?: number;     // Expiration timestamp
}
```

### Connection Errors

If authentication fails (missing, invalid, or expired token), the connection is **rejected**:

```typescript
socket.on("connect_error", (error) => {
  if (error.message === "UNAUTHORIZED") {
    // Token is missing, invalid, or expired
    // Redirect user to login
  }
});
```

> ⚠️ If the decoded JWT has no `userId`, the socket is immediately **force-disconnected** after connection.

---

## 🎯 User Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              USER FLOW DIAGRAM                             │
└─────────────────────────────────────────────────────────────────────────────┘

  ┌──────────┐     ┌───────────┐     ┌────────────────────┐     ┌────────────┐
  │ CONNECT  │────▶│ JOIN ROOM │────▶│ RECEIVE SNAPSHOT   │────▶│ VIEW OTHER │
  │ (auth)   │     │ (roomId)  │     │ (active users)     │     │ RUNNERS    │
  └──────────┘     └───────────┘     └────────────────────┘     └────────────┘
                          │                     │                      │
                          │                     │                      ▼
                          │                     │            ┌─────────────────┐
                          │                     │            │ RECEIVE LIVE    │
                          │                     │            │ location:update │
                          │                     │            └─────────────────┘
                          │                     │
                          ▼                     │
                   ┌─────────────┐              │
                   │START SESSION│◀─────────────┘
                   │(roomId +    │
                   │ sessionId)  │
                   └─────────────┘
                          │
                          ▼
                   ┌─────────────┐
                   │SEND LOCATION│◀──────────────────────────┐
                   │   UPDATES   │                           │
                   └─────────────┘                           │
                          │                                  │
                          ▼                                  │
                   ┌─────────────┐    ┌───────────────┐      │
                   │ STORE LOCAL │───▶│ RENDER PATH   │──────┘
                   │   (client)  │    │ ON MAP        │  (continue running)
                   └─────────────┘    └───────────────┘
                          │
                          ▼
                   ┌─────────────┐
                   │ END SESSION │
                   └─────────────┘
```

---

## 📤 Client → Server Events

### 1. `join-room`

Join a room to receive location updates from other active users. After joining, the server immediately responds with a `location:snapshot` event.

**Emit:**

```typescript
socket.emit("join-room", roomId: string);
```

**Example:**

```typescript
socket.emit("join-room", "central-park-runners");
```

| Parameter | Type     | Required | Description                          |
|-----------|----------|----------|--------------------------------------|
| `roomId`  | `string` | ✅       | Any unique string identifier for the room |

**Server Response:** Emits `location:snapshot` with all currently active users in the room.

**Error Handling:** If `roomId` is empty/falsy, the request is **silently ignored** (no error emitted).

---

### 2. `start-session`

Start a running session to begin broadcasting your location to other users in the room.

**Emit:**

```typescript
socket.emit("start-session", {
  roomId: string,
  sessionId: number
});
```

**Example:**

```typescript
socket.emit("start-session", {
  roomId: "central-park-runners",
  sessionId: 12345  // Obtained from your Express/REST backend
});
```

| Parameter   | Type     | Required | Description                                   |
|-------------|----------|----------|-----------------------------------------------|
| `roomId`    | `string` | ✅       | Must match the room you joined earlier         |
| `sessionId` | `number` | ✅       | Session ID obtained from your Express backend  |

**What happens internally:**
1. If this socket was attached to a different session, it is **detached** from the previous one.
2. If the user already has an active session in this room (e.g., from another device), the socket is **added** to the existing session's socket set.
3. Any pending reconnect timer is **cancelled**.
4. The socket joins the Socket.IO room `room:{roomId}`.

**Error Handling:** If `roomId` or `sessionId` is missing, the request is **silently ignored**.

---

### 3. `location:update`

Send your current GPS location. **Only works after `start-session`** — if no active session exists for this socket, the update is silently ignored.

**Emit:**

```typescript
socket.emit("location:update", {
  lat: number,
  lng: number
});
```

**Example:**

```typescript
socket.emit("location:update", {
  lat: 40.785091,
  lng: -73.968285
});
```

| Parameter | Type     | Required | Description          |
|-----------|----------|----------|----------------------|
| `lat`     | `number` | ✅       | Latitude coordinate  |
| `lng`     | `number` | ✅       | Longitude coordinate |

**What happens internally:**
1. A `ts` (Unix timestamp in ms) is **added by the server** via `Date.now()`.
2. The user's in-memory location is **updated**.
3. The location point is **appended** to a Redis list: `session:{sessionId}:path`.
4. The last known location is **stored** in Redis: `session:{sessionId}:user:{userId}:last-location`.
5. The location (with `userId` and `ts`) is **broadcast** to all other users in the room via `location:update`.

**Error Handling:** Silently ignored if the socket is not in an active session.

---

### 4. `end-session`

End your running session. Stops broadcasting your location and notifies other users.

**Emit:**

```typescript
socket.emit("end-session");
// No payload required
```

**What happens internally:**
1. All sockets belonging to this user's session are **removed** from the room.
2. The user's session is **deleted** from in-memory state.
3. If the room becomes empty, it is **cleaned up** from memory.
4. A `user:offline` event is **broadcast** to remaining room members.

**Error Handling:** Silently ignored if the socket is not in an active session.

---

### 5. `reconnect-session`

Attempt to resume a previously active session after a disconnection. This must be called within the **reconnect grace period** (`SESSION_RESUME_WINDOW_MS`, default 30s).

**Emit:**

```typescript
socket.emit("reconnect-session", {
  roomId: string,
  sessionId?: number  // Optional — used for validation
});
```

**Example:**

```typescript
socket.emit("reconnect-session", {
  roomId: "central-park-runners",
  sessionId: 12345
});
```

| Parameter   | Type     | Required | Description                                                |
|-------------|----------|----------|------------------------------------------------------------|
| `roomId`    | `string` | ✅       | The room to reconnect to                                   |
| `sessionId` | `number` | ❌       | If provided, must match the active session's ID for validation |

**Server Response:**

| Scenario | Event Emitted | Payload |
|----------|---------------|---------|
| ✅ Success | `session:resumed` | `{ roomId, sessionId, location, disconnectedAt }` |
| ❌ `roomId` missing | `session:resume-failed` | `{ reason: "room-missing" }` |
| ❌ No active session found | `session:resume-failed` | `{ reason: "not-active" }` |
| ❌ `sessionId` doesn't match | `session:resume-failed` | `{ reason: "session-mismatch" }` |

---

## 📥 Server → Client Events

### 1. `location:snapshot`

Received **immediately after** emitting `join-room`. Contains all currently active users in the room with their last known location.

**Listen:**

```typescript
socket.on("location:snapshot", (snapshot) => {
  // Render all active users on the map
});
```

**Payload:**

```typescript
type LocationSnapshot = Array<{
  userId: number;
  lat: number;
  lng: number;
  ts: number;      // Unix timestamp (milliseconds)
}>;
```

**Example Response:**

```json
[
  { "userId": 1, "lat": 40.785091, "lng": -73.968285, "ts": 1706636270000 },
  { "userId": 2, "lat": 40.782865, "lng": -73.965355, "ts": 1706636268000 },
  { "userId": 3, "lat": 40.779437, "lng": -73.963244, "ts": 1706636265000 }
]
```

> 💡 Users who have an active session but haven't sent any location update yet are **excluded** from the snapshot (their `location` is `null`).

> 💡 If no users are active in the room, an **empty array** `[]` is returned.

---

### 2. `location:update`

Received when **another user** in the room sends a location update. You will **not** receive your own updates.

**Listen:**

```typescript
socket.on("location:update", (data) => {
  // Update user's position on the map
});
```

**Payload:**

```typescript
interface LocationUpdate {
  userId: number;   // The user who sent this update
  lat: number;
  lng: number;
  ts: number;       // Unix timestamp (milliseconds), set by the server
}
```

**Example Response:**

```json
{ "userId": 5, "lat": 40.785091, "lng": -73.968285, "ts": 1706636270000 }
```

---

### 3. `user:offline`

Received when a user **ends their session** or **all their sockets disconnect** (after the reconnect grace period expires).

**Listen:**

```typescript
socket.on("user:offline", (data) => {
  // Remove user marker from the map
});
```

**Payload:**

```typescript
interface UserOffline {
  userId: number;
}
```

**Example Response:**

```json
{ "userId": 5 }
```

---

### 4. `session:resumed`

Received after a **successful** `reconnect-session` request. Contains the restored session state.

**Listen:**

```typescript
socket.on("session:resumed", (data) => {
  // Session is restored — resume location tracking
});
```

**Payload:**

```typescript
interface SessionResumed {
  roomId: string;
  sessionId: number;
  location: {           // Last known location (null if no location was sent yet)
    lat: number;
    lng: number;
    ts: number;
  } | null;
  disconnectedAt: number | null;  // Unix timestamp (ms) when disconnect happened
}
```

**Example Response:**

```json
{
  "roomId": "central-park-runners",
  "sessionId": 12345,
  "location": { "lat": 40.785091, "lng": -73.968285, "ts": 1706636270000 },
  "disconnectedAt": 1706636290000
}
```

---

### 5. `session:resume-failed`

Received when a `reconnect-session` request **fails**.

**Listen:**

```typescript
socket.on("session:resume-failed", (data) => {
  // Handle failure — start a new session instead
});
```

**Payload:**

```typescript
interface SessionResumeFailed {
  reason: "room-missing" | "not-active" | "session-mismatch";
}
```

| Reason | Description |
|--------|-------------|
| `room-missing` | No `roomId` was provided in the reconnect request |
| `not-active` | No active session exists for this user in the given room (expired or ended) |
| `session-mismatch` | The provided `sessionId` doesn't match the server's active session ID |

**Example Response:**

```json
{ "reason": "not-active" }
```

---

## 🗺️ Events Summary Table

| Event | Direction | Payload (Input) | Response/Broadcast | When to Use |
|-------|-----------|------------------|--------------------|-------------|
| `join-room` | Client → Server | `roomId: string` | `location:snapshot` → caller | After connecting, join a tracking room |
| `start-session` | Client → Server | `{ roomId, sessionId }` | — | When user starts a running session |
| `location:update` | Client → Server | `{ lat, lng }` | `location:update` → room (others) | During active session, share GPS location |
| `end-session` | Client → Server | *none* | `user:offline` → room (others) | When user ends running session |
| `reconnect-session` | Client → Server | `{ roomId, sessionId? }` | `session:resumed` or `session:resume-failed` → caller | After reconnecting, resume a session |
| `location:snapshot` | Server → Client | — | `[{ userId, lat, lng, ts }, ...]` | Sent after `join-room` |
| `location:update` | Server → Client | — | `{ userId, lat, lng, ts }` | Real-time location from other users |
| `user:offline` | Server → Client | — | `{ userId }` | When another user ends/disconnects |
| `session:resumed` | Server → Client | — | `{ roomId, sessionId, location, disconnectedAt }` | Successful session reconnection |
| `session:resume-failed` | Server → Client | — | `{ reason }` | Failed session reconnection |

---

## 🗄️ Redis Data Model

All location data is persisted in Redis with a **6-hour TTL**.

| Key Pattern | Type | TTL | Description |
|-------------|------|-----|-------------|
| `session:{sessionId}:path` | List (`RPUSH`) | 6 hours | Ordered list of **all** location points for a session. Each entry is a JSON string: `{"lat":..., "lng":..., "ts":...}` |
| `session:{sessionId}:user:{userId}:last-location` | String (`SET`) | 6 hours | The **last known** location for a user in a session. JSON string: `{"lat":..., "lng":..., "ts":...}` |

### Example Redis Entries

```
# Path points (list — appended on each location:update)
session:12345:path → [
  '{"lat":40.785091,"lng":-73.968285,"ts":1706636270000}',
  '{"lat":40.785120,"lng":-73.968300,"ts":1706636272000}',
  ...
]

# Last known location (string — overwritten on each location:update)
session:12345:user:42:last-location → '{"lat":40.785120,"lng":-73.968300,"ts":1706636272000}'
```

---

## 🧠 In-Memory Data Structures

The server maintains two primary Maps for real-time state:

### `activeUsersByRoom`

```
Map<roomId, Map<userId, ActiveUserSession>>
```

```typescript
interface ActiveUserSession {
  sessionId: number;                              // Session ID from backend
  sockets: Set<string>;                           // All connected socket IDs for this user
  location: { lat, lng, ts } | null;              // Last known location
  reconnectTimer: ReturnType<typeof setTimeout> | null;  // Cleanup timer after disconnect
  disconnectedAt: number | null;                  // Timestamp of last disconnect
}
```

### `activeBySocket`

```
Map<socketId, { roomId, userId, sessionId }>
```

Quick lookup from a socket ID to its room/user/session context.

---

## 🔄 Session Reconnection Flow

When a user disconnects (network drop, app backgrounded, etc.), the server does **not** immediately remove them. Instead:

```
┌──────────────┐
│   DISCONNECT │    Socket disconnects
└──────┬───────┘
       │
       ▼
┌──────────────────────────┐
│  Socket removed from     │    The specific socket is detached
│  user's socket set       │
└──────┬───────────────────┘
       │
       ▼
  ┌────────────────┐
  │ Any sockets    │── YES ──▶ Session stays fully active
  │ remaining?     │           (multi-device scenario)
  └────┬───────────┘
       │ NO
       ▼
┌──────────────────────────┐
│  Start reconnect timer   │    Default: 30 seconds
│  (SESSION_RESUME_WINDOW) │
└──────┬───────────────────┘
       │
       ├──── User reconnects within window ────▶ ✅ session:resumed
       │     (via reconnect-session event)         Timer cancelled
       │                                           Socket re-attached
       │
       └──── Timer expires ────▶ ❌ finalizeSession()
                                    user:offline broadcast
                                    Session removed from memory
```

> 💡 **Multi-device support:** A single user can have multiple sockets attached to the same session. The session only enters the reconnect grace period when **all** sockets are disconnected.

---

## 🔄 Connection State Diagram

```
                                  ┌──────────────────┐
                                  │   DISCONNECTED   │
                                  └────────┬─────────┘
                                           │
                                    connect(token)
                                           │
                                           ▼
                              ┌────────────────────────┐
                              │      CONNECTING        │
                              └────────────┬───────────┘
                                           │
                         ┌─────────────────┴─────────────────┐
                         │                                   │
                   auth success                         auth failed
                         │                                   │
                         ▼                                   ▼
              ┌──────────────────┐                ┌──────────────────┐
              │    CONNECTED     │                │   AUTH ERROR     │
              │  (can join room) │                │  (UNAUTHORIZED)  │
              └────────┬─────────┘                └──────────────────┘
                       │
                 join-room(roomId)
                       │
                       ▼
              ┌──────────────────┐
              │   IN ROOM        │◀────────────────────────┐
              │ (spectator mode) │                         │
              └────────┬─────────┘                         │
                       │                                   │
              start-session(...)                     end-session
                       │                                   │
                       ▼                                   │
              ┌──────────────────┐                         │
              │  ACTIVE SESSION  │─────────────────────────┘
              │  (sending locs)  │
              └────────┬─────────┘
                       │
                 disconnect
                       │
                       ▼
              ┌──────────────────┐
              │   GRACE PERIOD   │── reconnect-session ──▶ ACTIVE SESSION
              │  (30s default)   │
              └────────┬─────────┘
                       │ timeout
                       ▼
              ┌──────────────────┐
              │  SESSION ENDED   │──▶ user:offline broadcast
              └──────────────────┘
```

---

## 📋 TypeScript Types (All)

```typescript
// ============ CONNECTION ============

interface SocketAuth {
  token: string;  // JWT token
}

interface JwtPayload {
  userId: number;
  iat?: number;
  exp?: number;
}

// ============ CLIENT → SERVER EVENTS ============

// join-room
type JoinRoomPayload = string;  // roomId

// start-session
interface StartSessionPayload {
  roomId: string;
  sessionId: number;
}

// location:update (sending)
interface LocationUpdatePayload {
  lat: number;
  lng: number;
}

// end-session
// No payload

// reconnect-session
interface ReconnectSessionPayload {
  roomId: string;
  sessionId?: number;  // Optional — used for validation
}

// ============ SERVER → CLIENT EVENTS ============

// Common location point
interface LocationPoint {
  lat: number;
  lng: number;
  ts: number;  // Unix timestamp in milliseconds
}

// location:snapshot
interface UserLocation extends LocationPoint {
  userId: number;
}
type LocationSnapshotPayload = UserLocation[];

// location:update (receiving)
interface LocationUpdateReceivedPayload {
  userId: number;
  lat: number;
  lng: number;
  ts: number;
}

// user:offline
interface UserOfflinePayload {
  userId: number;
}

// session:resumed
interface SessionResumedPayload {
  roomId: string;
  sessionId: number;
  location: LocationPoint | null;
  disconnectedAt: number | null;
}

// session:resume-failed
interface SessionResumeFailedPayload {
  reason: "room-missing" | "not-active" | "session-mismatch";
}
```

---

## 💻 Complete Frontend Implementation Example

```typescript
import { io, Socket } from "socket.io-client";

class ViciSocketService {
  private socket: Socket | null = null;
  private localPath: Array<{ lat: number; lng: number; ts: number }> = [];
  private currentRoom: string | null = null;
  private currentSessionId: number | null = null;

  // ── Connection ──────────────────────────────────────

  connect(token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = io("ws://YOUR_SERVER_HOST:3000", {
        auth: { token }
      });

      this.socket.on("connect", () => {
        console.log("Connected:", this.socket?.id);
        resolve();
      });

      this.socket.on("connect_error", (error) => {
        console.error("Connection failed:", error.message);
        reject(error);
      });

      this.setupEventListeners();
    });
  }

  // ── Room ────────────────────────────────────────────

  joinRoom(roomId: string): void {
    this.currentRoom = roomId;
    this.socket?.emit("join-room", roomId);
  }

  // ── Session ─────────────────────────────────────────

  startSession(roomId: string, sessionId: number): void {
    this.localPath = [];
    this.currentSessionId = sessionId;
    this.socket?.emit("start-session", { roomId, sessionId });
  }

  endSession(): void {
    this.socket?.emit("end-session");
    this.currentSessionId = null;
  }

  // ── Location ────────────────────────────────────────

  sendLocation(lat: number, lng: number): void {
    const point = { lat, lng, ts: Date.now() };
    this.localPath.push(point);               // Store locally for path rendering
    this.socket?.emit("location:update", { lat, lng });
  }

  getLocalPath() {
    return this.localPath;
  }

  // ── Reconnection ───────────────────────────────────

  reconnectSession(): void {
    if (!this.currentRoom) return;
    this.socket?.emit("reconnect-session", {
      roomId: this.currentRoom,
      sessionId: this.currentSessionId ?? undefined,
    });
  }

  // ── Cleanup ─────────────────────────────────────────

  disconnect(): void {
    this.socket?.disconnect();
    this.socket = null;
  }

  // ── Event Listeners ─────────────────────────────────

  private setupEventListeners(): void {
    if (!this.socket) return;

    // Snapshot of all active users (after join-room)
    this.socket.on("location:snapshot", (snapshot) => {
      console.log("Active users:", snapshot);
      // snapshot: [{ userId, lat, lng, ts }, ...]
      // → Render all users on the map
    });

    // Real-time location from other users
    this.socket.on("location:update", (data) => {
      console.log("User moved:", data);
      // data: { userId, lat, lng, ts }
      // → Update user marker on map
    });

    // Another user went offline
    this.socket.on("user:offline", (data) => {
      console.log("User offline:", data.userId);
      // → Remove user marker from map
    });

    // Session successfully resumed after reconnect
    this.socket.on("session:resumed", (data) => {
      console.log("Session resumed:", data);
      // data: { roomId, sessionId, location, disconnectedAt }
      // → Restore state and continue tracking
    });

    // Session resume failed
    this.socket.on("session:resume-failed", (data) => {
      console.log("Resume failed:", data.reason);
      // reason: "room-missing" | "not-active" | "session-mismatch"
      // → Start a fresh session instead
    });
  }
}

// ── Usage ──────────────────────────────────────────────

async function main() {
  const vici = new ViciSocketService();

  // 1. Connect with JWT
  await vici.connect("your-jwt-token");

  // 2. Join a room to see other runners
  vici.joinRoom("morning-runners");

  // 3. When user taps "Start Run"
  vici.startSession("morning-runners", 12345);

  // 4. During the run — send GPS location periodically
  vici.sendLocation(40.785091, -73.968285);

  // 5. If socket disconnects and reconnects
  vici.reconnectSession();

  // 6. When user taps "End Run"
  vici.endSession();

  // 7. Access the run path for analytics
  const runPath = vici.getLocalPath();
}
```

---

## ⚠️ Important Notes

1. **Order Matters** — Always `join-room` before `start-session`
2. **Local Path Storage** — Store your own location updates locally for path rendering. The server stores them in Redis but doesn't send them back to you.
3. **Reconnect Grace Period** — After disconnect, the session stays alive for 30 seconds (configurable via `SESSION_RESUME_WINDOW_MS`). Use `reconnect-session` within this window.
4. **Session ID** — Must be obtained from your Express/REST backend before starting a session.
5. **Multi-Device Support** — The same user can connect from multiple devices/sockets. All sockets are tracked per user per room.
6. **Auto-Cleanup** — If all of a user's sockets disconnect and the grace period expires, `user:offline` is broadcast automatically.
7. **Silent Validation** — `join-room`, `start-session`, `location:update`, and `end-session` **silently ignore** malformed payloads. Only `reconnect-session` sends error responses.
8. **Server-Side Timestamps** — The `ts` field in `location:update` broadcasts is set by the server via `Date.now()`, not by the client.
9. **Redis TLS** — If your `REDIS_URL` starts with `rediss://`, TLS is automatically enabled with `rejectUnauthorized: false`.
10. **Redis Retry** — The server retries Redis connections up to 10 times with exponential backoff (100ms → 3000ms), and auto-reconnects on `READONLY`, `ECONNRESET`, and `ETIMEDOUT` errors.

---

## 📡 Server Information

| Property | Value |
|----------|-------|
| **Protocol** | WebSocket (Socket.IO v4) |
| **Default Port** | `3000` |
| **Bind Address** | `0.0.0.0` (all interfaces) |
| **Authentication** | JWT via handshake `auth` or `headers` |
| **Data Persistence** | Redis (TTL: 6 hours) |
| **Reconnect Grace Period** | 30 seconds (configurable) |
| **HTTP Health Check** | `GET /` → `200 OK "Socket server is running"` |
