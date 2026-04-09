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
| `SESSION_RESUME_WINDOW_MS` | ❌ No | `172800000` (48h) | Time (in ms) a disconnected session stays alive before cleanup |
| `FLUSH_INTERVAL_MS` | ❌ No | `10000` (10s) | How often buffered location points are flushed to Redis (in ms) |

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
  sessionId: number,
  sessionMode?: "normal" | "ghost" | "private"  // Optional, defaults to "normal"
});
```

**Example:**

```typescript
// Normal mode (default) — location is shared with the room
socket.emit("start-session", {
  roomId: "central-park-runners",
  sessionId: 12345
});

// Ghost mode — Location is NOT broadcast to the room, but the session STILL captures territory
socket.emit("start-session", {
  roomId: "central-park-runners",
  sessionId: 12345,
  sessionMode: "ghost"
});

// Private mode — Location is NOT broadcast to the room, and the session SKIPS territory capture
socket.emit("start-session", {
  roomId: "central-park-runners",
  sessionId: 12345,
  sessionMode: "private"
});
```

| Parameter     | Type     | Required | Description                                   |
|---------------|----------|----------|-----------------------------------------------|
| `roomId`      | `string` | ✅       | Must match the room you joined earlier         |
| `sessionId`   | `number` | ✅       | Session ID obtained from your Express backend  |
| `sessionMode` | `string` | ❌       | `"normal"` (default), `"ghost"`, or `"private"`. Ghost and private suppress all room broadcasts. |

**What happens internally:**
1. If this socket was attached to a different session, it is **detached** from the previous one.
2. If the user already has an active session in this room (e.g., from another device), the socket is **added** to the existing session's socket set.
3. Any pending reconnect timer is **cancelled**.
4. The socket joins the Socket.IO room `room:{roomId}`.
5. If `sessionMode` is `"ghost"` or `"private"`, the user enters **stealth mode** — see [Session Modes](#-session-modes) below.

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
1. If the location is **identical** to the last known position (same `lat`/`lng`), it is **silently skipped** (consecutive deduplication).
2. A `ts` (Unix timestamp in ms) is **added by the server** via `Date.now()`.
3. The user's in-memory location is **updated**.
4. The location point is **buffered** in memory (flushed to Redis every 10 seconds via `RPUSH` to `session:{sessionId}:path`).
5. The location (with `userId`, `ts`, and `avatarUrl`) is **broadcast immediately** to all other users in the room via `location:update` (skipped in ghost/private mode).

> 💡 **Buffered writes:** Location points are NOT written to Redis on every update. They are collected in an in-memory buffer and flushed to Redis every 10 seconds (configurable via `FLUSH_INTERVAL_MS`). The buffer is always flushed before `end-session` and on disconnect. Real-time broadcasts to other users are **not affected** — they happen immediately.

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
4. A `user:offline` event is **broadcast** to remaining room members (skipped in ghost/private mode).

**Error Handling:** Silently ignored if the socket is not in an active session.

---

### 5. `reconnect-session`

Attempt to resume a previously active session after a disconnection. This must be called within the **reconnect grace period** (`SESSION_RESUME_WINDOW_MS`, default 48 hours).

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

### 6. `location:sync-buffered`

Send buffered location points that were collected while the socket was disconnected. **Must be called after a successful `reconnect-session`** — the socket needs an active session.

**Emit:**

```typescript
socket.emit("location:sync-buffered", {
  locations: [
    { lat: 40.785091, lng: -73.968285, ts: 1706636270000 },
    { lat: 40.785120, lng: -73.968300, ts: 1706636272000 },
    { lat: 40.785150, lng: -73.968320, ts: 1706636274000 }
  ]
});
```

| Parameter   | Type                                    | Required | Description                                       |
|-------------|-----------------------------------------|----------|---------------------------------------------------|
| `locations` | `Array<{ lat, lng, ts }>` | ✅       | Buffered location points with client-side timestamps |

**What happens internally:**
1. Validates the socket has an active session.
2. Validates `locations` is a non-empty array.
3. **Deduplicates** — filters out points with `ts <= lastKnownTimestamp` (already received before disconnect).
4. Uses a single Redis pipeline to `RPUSH` only the **new** points into `session:{sessionId}:path`.
5. Updates `last-location` key with the **last** point.
6. Updates in-memory location state.
7. Emits `location:sync-ack` with `{ count }` — the number of **new** points stored (may be 0 if all were duplicates).
8. Broadcasts the latest position to the room (skipped in ghost/private mode).

> ⚠️ Buffered points use the **frontend's `ts`** (historical timestamps), unlike `location:update` which uses server-side `Date.now()`.

**Server Response:** Emits `location:sync-ack` with `{ count: number }`.

**Error Handling:** Silently ignored if the socket is not in an active session or `locations` is empty.

---

### 7. `session:pause`

Pause the current running session. The user will be treated as **offline** — their marker is removed for other users, and any `location:update` events sent while paused are **silently rejected**. The session stays alive (it is NOT ended), and the socket remains connected.

**Emit:**

```typescript
socket.emit("session:pause");
// No payload required
```

**What happens internally:**
1. The user's session is flagged as `paused = true`.
2. A `user:offline` event is broadcast to other users in the room — markers removed (skipped in ghost/private mode).
3. Any incoming `location:update` events are **silently rejected** while paused.
4. The user is **excluded from `location:snapshot`** results while paused.
5. A `session:paused` acknowledgement is sent back to the caller.

**Server Response:** Emits `session:paused` with `{ sessionId }`.

**Error Handling:** Silently ignored if the socket is not in an active session.

---

### 8. `session:resume`

Resume a paused session. The user becomes online again — location updates are accepted, and other users are notified.

**Emit:**

```typescript
socket.emit("session:resume");
// No payload required
```

**What happens internally:**
1. The user's session is unflagged (`paused = false`).
2. If the user has a last known location, a `user:online` event is broadcast to other users in the room (skipped in ghost/private mode).
3. `location:update` events are accepted again.
4. The user reappears in `location:snapshot` results (except in ghost/private mode).
5. A `session:resumed-active` acknowledgement is sent back to the caller.

**Server Response:** Emits `session:resumed-active` with `{ sessionId }`.

**Error Handling:** Silently ignored if the socket is not in an active session.

---

### 9. `discard-session` (or `discard-sesion`)

Completely discard and delete the current running session's location data from Redis, and end the session. Stops broadcasting your location and removes your data from the server.

**Emit:**

```typescript
socket.emit("discard-session");
// No payload required
```

**What happens internally:**
1. All location history (`session:{sessionId}:path`) for this session is **deleted** from Redis.
2. The last known location (`session:{sessionId}:user:{userId}:last-location`) is **deleted** from Redis.
3. The session is **ended** identically to `end-session` (removed from memory, `user:offline` broadcast to room — skipped in ghost/private mode).

**Error Handling:** Silently ignored if the socket is not in an active session.

---

## 📥 Server → Client Events

### 1. `location:snapshot`

Received **immediately after** emitting `join-room`. Contains only **currently connected** users in the room with their last known location. Users who disconnected (even if within the reconnect window), paused users, and users in **ghost/private mode** are **excluded**.

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
  avatarUrl: string;  // User's avatar URL (from Redis cache)
}>;
```

**Example Response:**

```json
[
  { "userId": 1, "lat": 40.785091, "lng": -73.968285, "ts": 1706636270000, "avatarUrl": "https://res.cloudinary.com/xxx/avatars/avatar1.jpg" },
  { "userId": 2, "lat": 40.782865, "lng": -73.965355, "ts": 1706636268000, "avatarUrl": "https://res.cloudinary.com/xxx/avatars/avatar3.jpg" },
  { "userId": 3, "lat": 40.779437, "lng": -73.963244, "ts": 1706636265000, "avatarUrl": "https://res.cloudinary.com/xxx/avatars/avatar7.jpg" }
]
```

> 💡 Users who have an active session but haven't sent any location update yet are **excluded** from the snapshot (their `location` is `null`).

> 💡 Users who are disconnected (within the 48h reconnect window but not currently connected) are **excluded** from the snapshot.

> 💡 Users in **ghost** or **private** session mode are **excluded** from the snapshot — they are invisible to other users.

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
  avatarUrl: string;  // User's avatar URL (from Redis cache)
}
```

**Example Response:**

```json
{ "userId": 5, "lat": 40.785091, "lng": -73.968285, "ts": 1706636270000, "avatarUrl": "https://res.cloudinary.com/xxx/avatars/avatar5.jpg" }
```

---

### 3. `user:offline`

Received **immediately** when a user's **last socket disconnects** or when a user **ends their session**. The frontend should remove the user's marker from the map right away. **Not sent** for users in ghost/private mode.

> ⚠️ **Changed behavior:** Previously, `user:offline` was only sent after the reconnect grace period expired. Now it is sent **immediately** on disconnect so the frontend does not show stale locations.

**Listen:**

```typescript
socket.on("user:offline", (data) => {
  // Remove user marker from the map immediately
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

### 4. `user:online`

Received when a user **reconnects** after being offline (their session was in the disconnected/grace period state and they re-attached a socket). The frontend should re-add the user's marker on the map. **Not sent** for users in ghost/private mode.

**Listen:**

```typescript
socket.on("user:online", (data) => {
  // Re-add user marker on the map
});
```

**Payload:**

```typescript
interface UserOnline {
  userId: number;
  lat: number;
  lng: number;
  ts: number;      // Unix timestamp (milliseconds)
  avatarUrl: string;  // User's avatar URL (from Redis cache)
}
```

**Example Response:**

```json
{ "userId": 5, "lat": 40.785091, "lng": -73.968285, "ts": 1706636290000, "avatarUrl": "https://res.cloudinary.com/xxx/avatars/avatar5.jpg" }
```

---

### 5. `session:resumed`

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

### 6. `session:resume-failed`

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
| `start-session` | Client → Server | `{ roomId, sessionId, sessionMode? }` | — | When user starts a running session |
| `location:update` | Client → Server | `{ lat, lng }` | `location:update` → room (others) ¹ | During active session, share GPS location |
| `end-session` | Client → Server | *none* | `user:offline` → room (others) ¹ | When user ends running session |
| `discard-session` | Client → Server | *none* | `user:offline` → room (others) ¹ | When user wants to cancel and delete their session data entirely |
| `reconnect-session` | Client → Server | `{ roomId, sessionId? }` | `session:resumed` or `session:resume-failed` → caller | After reconnecting, resume a session |
| `location:sync-buffered` | Client → Server | `{ locations: [{ lat, lng, ts }, ...] }` | `location:sync-ack` → caller | After reconnect, send buffered locations |
| **`session:pause`** | **Client → Server** | ***none*** | **`session:paused` → caller, `user:offline` → room** ¹ | **Temporarily stop sharing location** |
| **`session:resume`** | **Client → Server** | ***none*** | **`session:resumed-active` → caller, `user:online` → room** ¹ | **Resume sharing location after pause** |
| `location:snapshot` | Server → Client | — | `[{ userId, lat, lng, ts, avatarUrl }, ...]` | Sent after `join-room` (only connected, unpaused, non-stealth users) |
| `location:update` | Server → Client | — | `{ userId, lat, lng, ts, avatarUrl }` | Real-time location from other users |
| `user:offline` | Server → Client | — | `{ userId }` | **Immediately** when a user disconnects, ends session, or **pauses** ¹ |
| `user:online` | Server → Client | — | `{ userId, lat, lng, ts, avatarUrl }` | When a disconnected user reconnects or **resumes** ¹ |
| `session:resumed` | Server → Client | — | `{ roomId, sessionId, location, disconnectedAt }` | Successful session reconnection |
| `session:resume-failed` | Server → Client | — | `{ reason }` | Failed session reconnection |
| `session:paused` | Server → Client | — | `{ sessionId }` | Acknowledgement that session is paused |
| `session:resumed-active` | Server → Client | — | `{ sessionId }` | Acknowledgement that session is resumed from pause |
| `location:sync-ack` | Server → Client | — | `{ count }` | Confirmation of buffered sync |

> ¹ Room broadcasts are **suppressed** in ghost/private session mode. Data is still saved to Redis.

---

## 🗄️ Redis Data Model

All location data is persisted in Redis with a **48-hour TTL**.

| Key Pattern | Type | TTL | Description |
|-------------|------|-----|-------------|
| `session:{sessionId}:path` | List (`RPUSH`) | 48 hours | Ordered list of **all** location points for a session. Each entry is a JSON string: `{"lat":..., "lng":..., "ts":...}`. Points are **buffered in memory** and flushed to Redis every 10 seconds. |
| `user:{userId}:avatar` | String (`SET`) | 48 hours | The user's avatar URL. **Written by the HTTP backend** when a session is created. Read by the WS server once at `start-session` and cached in memory. Explicitly deleted on `discard-session`. |

> 💡 The `session:{sessionId}:user:{userId}:last-location` key has been **removed**. The last known location is now tracked only in memory (`userData.location`). The backend only needs `session:{id}:path` (via `LRANGE`) at session end.

### Example Redis Entries

```
# Path points (list — flushed from memory buffer every 10 seconds)
session:12345:path → [
  '{"lat":40.785091,"lng":-73.968285,"ts":1706636270000}',
  '{"lat":40.785120,"lng":-73.968300,"ts":1706636272000}',
  ...
]

# User avatar (string — written by HTTP backend at session creation)
user:42:avatar → 'https://res.cloudinary.com/xxx/avatars/avatar3.jpg'
```

---

## 🧠 In-Memory Data Structures

The server maintains two primary Maps for real-time state:

### `activeUsersByRoom`

```
Map<roomId, Map<userId, ActiveUserSession>>
```

```typescript
type SessionMode = 'normal' | 'ghost' | 'private';

interface ActiveUserSession {
  sessionId: number;                              // Session ID from backend
  sockets: Set<string>;                           // All connected socket IDs for this user
  location: { lat, lng, ts } | null;              // Last known location (in-memory only)
  reconnectTimer: ReturnType<typeof setTimeout> | null;  // Cleanup timer after disconnect
  disconnectedAt: number | null;                  // Timestamp of last disconnect
  paused: boolean;                                // Whether the session is paused
  sessionMode: SessionMode;                       // 'normal', 'ghost', or 'private'
  avatarUrl: string;                              // User's avatar URL (read from Redis at session start)
  pathBuffer: Location[];                         // Buffered location points (flushed to Redis every 10s)
  flushTimer: ReturnType<typeof setInterval> | null;  // Periodic flush timer
}
```

### `activeBySocket`

```
Map<socketId, { roomId, userId, sessionId, sessionMode }>
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
type SessionMode = 'normal' | 'ghost' | 'private';

interface StartSessionPayload {
  roomId: string;
  sessionId: number;
  sessionMode?: SessionMode;  // Optional — defaults to 'normal'
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
  avatarUrl: string;
}
type LocationSnapshotPayload = UserLocation[];

// location:update (receiving)
interface LocationUpdateReceivedPayload {
  userId: number;
  lat: number;
  lng: number;
  ts: number;
  avatarUrl: string;
}

// user:offline
interface UserOfflinePayload {
  userId: number;
}

// user:online
interface UserOnlinePayload {
  userId: number;
  lat: number;
  lng: number;
  ts: number;
  avatarUrl: string;
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

// location:sync-buffered
interface SyncBufferedPayload {
  locations: Array<{
    lat: number;
    lng: number;
    ts: number;  // Client-side timestamp (ms)
  }>;
}

// location:sync-ack
interface SyncAckPayload {
  count: number;
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

  startSession(roomId: string, sessionId: number, sessionMode?: "normal" | "ghost" | "private"): void {
    this.localPath = [];
    this.currentSessionId = sessionId;
    this.socket?.emit("start-session", { roomId, sessionId, sessionMode });
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

  // ── Buffered Sync ──────────────────────────────────

  syncBufferedLocations(locations: Array<{ lat: number; lng: number; ts: number }>): void {
    if (locations.length === 0) return;
    this.socket?.emit("location:sync-buffered", { locations });
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
      // snapshot: [{ userId, lat, lng, ts, avatarUrl }, ...]
      // → Render all users on the map with their avatar
    });

    // Real-time location from other users
    this.socket.on("location:update", (data) => {
      console.log("User moved:", data);
      // data: { userId, lat, lng, ts, avatarUrl }
      // → Update user marker on map (use avatarUrl for the marker image)
    });

    // Another user went offline (fires immediately on disconnect or end-session)
    this.socket.on("user:offline", (data) => {
      console.log("User offline:", data.userId);
      // → Remove user marker from map immediately
    });

    // A previously offline user reconnected
    this.socket.on("user:online", (data) => {
      console.log("User back online:", data.userId);
      // data: { userId, lat, lng, ts, avatarUrl }
      // → Re-add user marker on the map with their avatar
    });

    // Session successfully resumed after reconnect
    this.socket.on("session:resumed", (data) => {
      console.log("Session resumed:", data);
      // data: { roomId, sessionId, location, disconnectedAt }
      // → Restore state and continue tracking
      // → Send buffered locations if any
    });

    // Buffered locations synced successfully
    this.socket.on("location:sync-ack", (data) => {
      console.log(`Synced ${data.count} buffered points`);
      // → Clear local buffer, resume normal location:update
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
  // Normal mode (default)
  vici.startSession("morning-runners", 12345);

  // Or ghost/private mode — location is NOT shared with the room
  // vici.startSession("morning-runners", 12345, "ghost");   // Still captures territory
  // vici.startSession("morning-runners", 12345, "private"); // Skips territory capture

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
3. **Reconnect Grace Period** — After disconnect, the session stays alive for **48 hours** (configurable via `SESSION_RESUME_WINDOW_MS`). Use `reconnect-session` within this window.
4. **Session ID** — Must be obtained from your Express/REST backend before starting a session.
5. **Multi-Device Support** — The same user can connect from multiple devices/sockets. All sockets are tracked per user per room.
6. **Immediate Offline** — When all of a user's sockets disconnect, `user:offline` is broadcast **immediately** (not after grace period). The session data stays alive for the reconnect window, but other users see them as offline right away.
7. **Online on Reconnect** — When a disconnected user reconnects within the grace period, `user:online` is broadcast with their last known location.
8. **Silent Validation** — `join-room`, `start-session`, `location:update`, and `end-session` **silently ignore** malformed payloads. Only `reconnect-session` sends error responses.
9. **Server-Side Timestamps** — The `ts` field in `location:update` broadcasts is set by the server via `Date.now()`, not by the client.
10. **Redis TLS** — If your `REDIS_URL` starts with `rediss://`, TLS is automatically enabled with `rejectUnauthorized: false`.
11. **Redis Retry** — The server retries Redis connections up to 10 times with exponential backoff (100ms → 3000ms), and auto-reconnects on `READONLY`, `ECONNRESET`, and `ETIMEDOUT` errors.
12. **Session Modes** — `start-session` accepts an optional `sessionMode`: `"ghost"` or `"private"`. Both suppress **all** room broadcasts (`location:update`, `user:online`, `user:offline`) and exclude the user from `location:snapshot`. Data saving to Redis is **unchanged**. Note that the backend completes Ghost sessions with full territory capture, while Private sessions skip territory capture.
13. **No Self-Events** — `user:online` and `user:offline` events from pause/resume/reconnect are sent only to **other** users in the room (via `socket.to()`), not to the user themselves.
14. **Buffered Path Writes** — Location points are **not** written to Redis on every update. They are buffered in memory and flushed every 10 seconds (configurable via `FLUSH_INTERVAL_MS`). The buffer is flushed on `end-session`, `disconnect`, and session finalization. On `discard-session`, the buffer is **cleared without flushing**.
15. **Consecutive Deduplication** — If a user sends a `location:update` with the same `lat`/`lng` as their last known position, it is silently skipped. This keeps path and area data clean by eliminating stationary noise.
16. **No `last-location` Key** — The `session:{id}:user:{id}:last-location` Redis key has been removed. Last known location is tracked only in memory.

---

## 📡 Server Information

| Property | Value |
|----------|-------|
| **Protocol** | WebSocket (Socket.IO v4) |
| **Default Port** | `3000` |
| **Bind Address** | `0.0.0.0` (all interfaces) |
| **Authentication** | JWT via handshake `auth` or `headers` |
| **Data Persistence** | Redis (TTL: 48 hours) |
| **Reconnect Grace Period** | 48 hours (configurable) |
| **HTTP Health Check** | `GET /` → `200 OK "Socket server is running"` |
