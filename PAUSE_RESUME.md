# ⏸️ Session Pause / Resume

> Added: 2026-03-18

Allows a user to **temporarily stop sharing their location** without ending the session. While paused, the user appears **offline** to other users (marker removed), and any `location:update` events are silently rejected. On resume, the user goes back **online** and location sharing continues.

---

## Why Socket-Only (No HTTP Needed)

- **No database mutation** — pause/resume is purely in-memory + Redis state.
- **The socket stays connected** — only a boolean flag toggles.
- **The session stays alive** — unlike `end-session`, nothing is destroyed.
- **Real-time by nature** — other users need instant notification (marker removal/restoration).

---

## New Events

### Client → Server

| Event | Payload | Description |
|-------|---------|-------------|
| `session:pause` | *none* | Pause the active session |
| `session:resume` | *none* | Resume a paused session |

### Server → Client

| Event | Payload | Description |
|-------|---------|-------------|
| `session:paused` | `{ sessionId: number }` | Acknowledgement that session is now paused |
| `session:resumed-active` | `{ sessionId: number }` | Acknowledgement that session is now resumed |
| `user:offline` | `{ userId: number }` | Broadcast to room when user pauses (existing event, new trigger) |
| `user:online` | `{ userId, lat, lng, ts }` | Broadcast to room when user resumes (existing event, new trigger) |

---

## Behavior Details

### On Pause (`session:pause`)

1. The user's session is flagged as `paused = true`.
2. `user:offline` is broadcast to all users in the room → **markers are removed**.
3. Any incoming `location:update` events from this user are **silently rejected**.
4. The user is **excluded from `location:snapshot`** results (new joiners won't see them).
5. `session:paused` acknowledgement is sent back to the caller.

### On Resume (`session:resume`)

1. The user's session is unflagged (`paused = false`).
2. If the user has a last known location, `user:online` is broadcast → **marker reappears**.
3. `location:update` events are accepted again.
4. The user reappears in `location:snapshot` results.
5. `session:resumed-active` acknowledgement is sent back to the caller.

### Edge Cases

| Scenario | Behavior |
|----------|----------|
| Pause when already paused | No-op, still sends `session:paused` ack |
| Resume when not paused | No-op, still sends `session:resumed-active` ack |
| Pause with no active session | Silently ignored |
| Disconnect while paused | Normal disconnect flow (socket detach → reconnect timer) |
| Reconnect after disconnect while paused | Pause flag is **reset to `false`** — user is back online |
| `end-session` while paused | Normal end-session flow (session destroyed) |

---

## State Diagram

```
                    ┌─────────────────┐
                    │  ACTIVE SESSION  │
                    │  (sending locs)  │
                    └────────┬────────┘
                             │
                     session:pause
                             │
                             ▼
                    ┌─────────────────┐
                    │     PAUSED      │──── location:update ──→ REJECTED
                    │  (appears       │
                    │   offline)      │
                    └────────┬────────┘
                             │
                     session:resume
                             │
                             ▼
                    ┌─────────────────┐
                    │  ACTIVE SESSION  │
                    │  (sending locs)  │
                    └─────────────────┘
```

---

## Frontend Usage

### Pausing

```typescript
// User taps "Pause" button
socket.emit("session:pause");

// Stop the GPS watcher / location interval
clearInterval(locationInterval);

socket.on("session:paused", ({ sessionId }) => {
  console.log(`Session ${sessionId} paused`);
  // Update UI to show "Paused" state
});
```

### Resuming

```typescript
// User taps "Resume" button
socket.emit("session:resume");

socket.on("session:resumed-active", ({ sessionId }) => {
  console.log(`Session ${sessionId} resumed`);
  // Restart the GPS watcher / location interval
  startLocationTracking();
});
```

### Other Users (Spectators)

No changes needed — the existing `user:offline` and `user:online` listeners handle pause/resume automatically:

```typescript
// These already work for pause/resume
socket.on("user:offline", ({ userId }) => {
  removeMarkerFromMap(userId);  // Called when user pauses OR disconnects
});

socket.on("user:online", (data) => {
  addMarkerToMap(data);  // Called when user resumes OR reconnects
});
```

---

## Changes Made

### `src/index.ts`

- Added `paused: boolean` to `ActiveUserSession` type.
- `location:update` handler rejects updates when `paused === true`.
- `location:snapshot` excludes paused users from the snapshot.
- New `session:pause` handler — sets flag, broadcasts `user:offline`, sends ack.
- New `session:resume` handler — clears flag, broadcasts `user:online`, sends ack.
- `attachSocketToSession` resets `paused = false` on reconnect.

### `FRONTEND_INTEGRATION.md`

- Added `session:pause` and `session:resume` to Client → Server events.
- Added `session:paused` and `session:resumed-active` to Server → Client events.
- Updated Events Summary Table with new rows and updated descriptions for `user:offline` / `user:online` / `location:snapshot`.
