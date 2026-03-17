# Changelog

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
