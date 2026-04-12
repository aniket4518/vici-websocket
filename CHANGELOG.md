# Changelog

## [2026-04-12] — Migration to Clerk Authentication

### ✨ New Features

#### Clerk Auth Integration

The WebSocket server now uses **Clerk** for authentication, replacing the legacy custom JWT implementation.

**Key Changes:**
- Connection requests now expect a valid Clerk JWT token in the `auth` payload or `headers`.
- The server validates these tokens using `@clerk/backend`.
- Instead of extracting a numeric `userId` directly from the token, the server uses the Clerk `sub` (user string ID) to query the database via Prisma and securely resolve the legacy numeric `userId`. This ensures complete compatibility with existing Redis location caching.

### ⚙️ Environment Variables Updated

- **Removed:** `JWT_SECRET` (No longer supported).
- **Added:** `CLERK_SECRET_KEY` — Required to verify the signatures of incoming Clerk tokens.
- **Added:** `DATABASE_URL` — Required by Prisma to perform the `clerkId` -> `id` mapping.

### 📱 Frontend Action Required

1. **Update Connection Payloads** — Replace the old custom JWT token with an active Clerk token when initializing the Socket.IO client.
   ```typescript
   // Connect with Clerk Token
   const socket = io("ws://YOUR_SERVER_HOST:3000", {
     auth: { token: "your-clerk-token" }
   });
   ```

### 📦 Dependency Changes

- **Removed:** `jsonwebtoken`
- **Added:** `@clerk/backend`
- **Added:** `@prisma/client` and `@prisma/adapter-pg`

---

## [2026-04-09] — User Avatar Support via Redis Cache

### ✨ New Features

#### Avatar URLs in Real-Time Events

All location-related events now include the user's `avatarUrl` field. The avatar URL is cached in Redis by the HTTP backend when a session is created, and read by the WS server once at `start-session`. This allows the frontend to render user avatar markers on the map without any additional API calls.

**Affected events (Server → Client):**

| Event | New field |
|-------|-----------|
| `location:snapshot` | `avatarUrl: string` added to each user entry |
| `location:update` | `avatarUrl: string` added to broadcast payload |
| `user:online` | `avatarUrl: string` added to reconnect/resume payload |

**How it works:**

1. HTTP backend writes `user:{userId}:avatar` to Redis when creating a session (48h TTL)
2. WS server reads it once at `start-session` and caches in memory
3. All outgoing events include `avatarUrl` — zero extra API calls for the frontend

**New Redis key:**

| Key Pattern | Type | TTL | Description |
|-------------|------|-----|-------------|
| `user:{userId}:avatar` | String (`SET`) | 48 hours | Written by HTTP backend, read by WS server |

**Cleanup:**

- `discard-session` — explicitly deletes `user:{userId}:avatar` from Redis
- `end-session` / disconnect — key auto-expires via 48h TTL (backend writes fresh on next session)
- In-memory avatar data is always cleaned when `finalizeSession` removes the user from the room map

### 📱 Frontend Action Required

1. **Update event handlers** — `location:snapshot`, `location:update`, and `user:online` now include `avatarUrl`. Use it to render the user's avatar on map markers.
2. **No extra API calls needed** — the avatar URL comes directly with location data.
3. **Handle empty string** — if `avatarUrl` is `""`, render a default/fallback avatar.

### 🔧 Backend Action Required

Add this to your session-start route (after fetching the user from DB):

```typescript
await redis.set(
  `user:${user.id}:avatar`,
  user.avatarUrl ?? '',
  'EX',
  172800  // 48h TTL
);
```

---

## [2026-04-09] — Performance Optimizations: Buffered Writes, Dedup & Cleanup

### ⚡ Performance

#### Buffered Path Writes to Redis

Location points are no longer written to Redis on every `location:update`. They are collected in an **in-memory buffer** and flushed to Redis in a single `RPUSH` every **10 seconds** (configurable via `FLUSH_INTERVAL_MS`).

| Metric | Before | After |
|--------|:------:|:-----:|
| Redis ops per location update | 4 | 0 (buffered) |
| Redis ops per 10 seconds | 40 | ~2 (1 RPUSH + 1 EXPIRE) |
| Redis ops per 1-hour run (1pt/sec) | ~14,400 | ~720 |
| Max simultaneous runners (100 ops/sec Redis) | ~25 | ~250+ |

**Flush triggers:**
- Every 10 seconds (periodic timer)
- On `end-session` (buffer flushed before finalization)
- On `disconnect` (buffer flushed before entering grace period)
- On `discard-session` (buffer **cleared without flushing** — data discarded)

**Real-time broadcasts are NOT affected** — `location:update` events to other users still happen immediately.

#### Removed `last-location` Redis Key

The `session:{sessionId}:user:{userId}:last-location` key has been **removed entirely**. Last known location is now tracked only in memory (`userData.location`). The backend only needs `session:{id}:path` via `LRANGE` at session end.

**Savings:** Eliminates 1 `SET` command per location update.

#### Consecutive Location Deduplication

If a user sends `location:update` with the same `lat`/`lng` as their last position, it is **silently skipped**.

Applied to both:
- `location:update` — single-point check against last position
- `location:sync-buffered` — consecutive duplicate removal across the entire array

**Benefits:** Cleaner path data, smaller Redis lists, more accurate area/territory calculations.

### ⚙️ New Environment Variable

| Variable | Default | Description |
|----------|---------|-------------|
| `FLUSH_INTERVAL_MS` | `10000` (10s) | How often buffered location points are flushed to Redis |

### ⚠️ Breaking Changes

- `session:{sessionId}:user:{userId}:last-location` Redis key no longer exists. If your backend reads this key, switch to reading the last element of `session:{id}:path` instead.

---

## [2026-04-01] — Ghost & Private Session Modes + Self-Marker Bug Fix

### ✨ New Features

#### Session Modes: Ghost & Private

`start-session` now accepts an optional `sessionMode` field: `"normal"` (default), `"ghost"`, or `"private"`.

In **ghost** or **private** mode, the user is completely invisible to other room members:

- `location:update` is **not** broadcast to the room
- `user:offline` is **not** broadcast on pause, disconnect, or session end
- `user:online` is **not** broadcast on resume or reconnect
- The user is **excluded** from `location:snapshot` results
- **Data persistence is unchanged** — path and last-location are still saved to Redis normally

**Emit:**

```typescript
socket.emit("start-session", {
  roomId: "central-park-runners",
  sessionId: 12345,
  sessionMode: "ghost"    // or "private"
});
```

Both modes suppress live socket broadcasts identically, but the backend treats their session endings differently:
- **Ghost:** The user captures standard territory and area at the end of the session, but is invisible to others live.
- **Private:** The user calculates their total area but explicitly **skips** territory capture.### 🐛 Bug Fix

#### Self-marker appearing on pause/resume/reconnect

Previously, `session:pause`, `session:resume`, and reconnect logic used `io.to(room)` to broadcast `user:offline` / `user:online` events. Since `io.to()` sends to **all** sockets in the room including the sender, the user received their own events — causing the frontend to display a marker for the user on themselves after resume.

**Fix:** Changed to `socket.to(room)` which excludes the sender socket. The `user:offline` / `user:online` events are now only received by **other** users in the room.

Affected handlers:
- `session:pause` — `user:offline` no longer sent to self
- `session:resume` — `user:online` no longer sent to self
- `attachSocketToSession` (reconnect) — `user:online` no longer sent to self

> Note: `detachSocket` and `finalizeSession` still use `io.to()` — this is correct because the user's socket is already disconnected/removed at that point.

### 📱 Frontend Action Required

1. **Update `start-session` call** — pass `sessionMode` if you want ghost/private mode:
   ```typescript
   socket.emit("start-session", { roomId, sessionId, sessionMode: "ghost" });
   ```
2. **No changes needed for self-marker fix** — the server now correctly excludes the sender from `user:online` / `user:offline` broadcasts.

---

## [2026-03-23] — Session Discard Capability

### ✨ New Features

#### `discard-session` (and `discard-sesion`) Event

Users can now completely cancel and delete their session data if they choose. Sending the `"discard-session"` event clears all tracked metrics from the server.

**Emit:**

```typescript
socket.emit("discard-session"); // Or socket.emit("discard-sesion");
// No payload required
```

**What happens internally:**
1. All Redis path history for the active session (`session:{sessionId}:path`) is immediately **deleted**.
2. The user's last known location (`session:{sessionId}:user:{userId}:last-location`) is **deleted**.
3. The session ends essentially mirroring `end-session`, dropping them from the socket trackers and immediately invoking a `user:offline` trigger across the room.

---

## [2026-03-17] — Fix Ghost Locations & Immediate Offline/Online Events

### 🐛 Bug Fix

#### Disconnected users appearing in `location:snapshot`

Users who disconnected (but were within the 48-hour reconnect window) were still included in the `location:snapshot` sent to newly joining users. This caused the frontend to show "ghost" markers for users who were no longer actively connected.

**Fix:** The snapshot now filters to only include users with `sockets.size > 0` and `disconnectedAt === null` (i.e., currently connected users).

### 🔧 Changes

#### `user:offline` now fires immediately on disconnect

Previously, `user:offline` was only broadcast when the 48-hour reconnect timer expired or when a user explicitly ended their session. Now it is broadcast **immediately** when a user's last socket disconnects, so the frontend can remove the marker right away.

The session data still stays alive for the 48h reconnect window — only the visibility to other users changes.

#### New `user:online` event on reconnect

When a disconnected user reconnects within the grace period, `user:online` is broadcast to the room with their last known location:

```typescript
socket.on("user:online", (data) => {
  // data: { userId, lat, lng, ts }
  // → Re-add user marker on the map
});
```

### 📱 Frontend Action Required

1. **Listen for `user:offline`** — When received, **remove** that user's marker from the map immediately
2. **Listen for `user:online`** — When received, **re-add** that user's marker on the map at the given location
3. The `location:snapshot` (from `join-room`) now only contains currently connected users, so no frontend changes needed for that

---

## [2026-03-16] — Buffered Location Sync & Extended Reconnect Window

### ✨ New Features

#### `location:sync-buffered` Event (Client → Server)

When the WebSocket disconnects while a user is running, the frontend should buffer location updates locally. After reconnecting and resuming the session, the frontend sends the buffered array to the server.

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

**Server behavior:**
1. Validates the socket has an active session
2. Validates `locations` is a non-empty array
3. **Deduplicates** — filters out any points with `ts <= lastKnownTimestamp` (locations the server already received before the disconnect)
4. Uses a single Redis pipeline to `RPUSH` only the new points into `session:{sessionId}:path`
5. Updates `last-location` key with the final point
6. Updates in-memory location state
7. Emits `location:sync-ack` with `{ count }` — the number of **new** points actually stored (may be less than what was sent)
8. Broadcasts the latest position to the room

> ⚠️ Buffered points use the **frontend's `ts`** (historical timestamps), unlike normal `location:update` which uses server-side `Date.now()`.

---

#### `location:sync-ack` Event (Server → Client)

Confirmation that the buffered locations were stored successfully.

**Listen:**

```typescript
socket.on("location:sync-ack", (data) => {
  console.log(`${data.count} buffered points synced`);
  // Safe to clear the local buffer now
});
```

**Payload:**

```typescript
interface SyncAckPayload {
  count: number;  // Number of buffered points that were stored
}
```

---

### 🔧 Changes

#### Reconnect Window: 30 seconds → 48 hours

The `SESSION_RESUME_WINDOW_MS` default has been changed from `30,000` (30 seconds) to `172,800,000` (48 hours). Users can now reconnect and resume a running session up to **48 hours** after disconnection.

This can still be overridden via the `SESSION_RESUME_WINDOW_MS` environment variable.

#### Redis TTL: 6 hours → 48 hours

All Redis key TTLs have been updated from 6 hours to 48 hours to match the extended reconnect window:

| Key Pattern | Old TTL | New TTL |
|-------------|---------|---------|
| `session:{sessionId}:path` | 6 hours | **48 hours** |
| `session:{sessionId}:user:{userId}:last-location` | 6 hours | **48 hours** |

---

### 📱 Frontend Reconnection Flow (Updated)

After the socket reconnects:

```
1. Socket connects (auto by Socket.IO)
2. Emit "reconnect-session" → receive "session:resumed"
3. Emit "location:sync-buffered" with buffered array → receive "location:sync-ack"
4. Clear local buffer
5. Resume normal "location:update" flow
```

**Example:**

```typescript
socket.on("session:resumed", (data) => {
  // Session restored — now sync buffered locations
  if (bufferedLocations.length > 0) {
    socket.emit("location:sync-buffered", { locations: bufferedLocations });
  }
});

socket.on("location:sync-ack", ({ count }) => {
  console.log(`Synced ${count} buffered points`);
  bufferedLocations = [];  // Clear the buffer
  // Resume normal location:update flow
});
```

---

### 📋 Updated Events Summary

| Event | Direction | Payload | Response | When to Use |
|-------|-----------|---------|----------|-------------|
| `location:sync-buffered` | Client → Server | `{ locations: [{ lat, lng, ts }, ...] }` | `location:sync-ack` → caller | After reconnect, send buffered locations |
| `location:sync-ack` | Server → Client | — | `{ count }` | Confirmation of buffered sync |

### 📋 Updated TypeScript Types

```typescript
// location:sync-buffered (sending)
interface SyncBufferedPayload {
  locations: Array<{
    lat: number;
    lng: number;
    ts: number;  // Client-side timestamp (ms)
  }>;
}

// location:sync-ack (receiving)
interface SyncAckPayload {
  count: number;
}
```
