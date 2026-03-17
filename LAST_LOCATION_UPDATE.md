# 🔄 Last Location Update — What Changed & What You Need To Do

> **Date:** 2026-03-17  
> **Issue:** Frontend showing last location of users who ended their session or disconnected

---

## ❌ The Problem

Users who **ended their session** or **disconnected** (e.g., closed the app, lost network) were still appearing on the map for other users. Their last known location was being shown as if they were still active.

**Root causes:**

1. The `location:snapshot` (sent when a user joins a room) included **disconnected users** who were within the 48-hour reconnect window — not just currently connected users.
2. The `user:offline` event was **only sent after 48 hours** (when the reconnect timer expired), so the frontend had no signal to remove the marker when a user actually disconnected.

---

## ✅ What Changed (Server Side)

### 1. `location:snapshot` now only includes connected users

The snapshot sent after `join-room` now **filters out** users who:
- Have no active sockets (`sockets.size === 0`)
- Are in disconnected/reconnect-pending state (`disconnectedAt !== null`)

**Before:** All users in the room (including disconnected ones within 48h window)  
**After:** Only users with an active socket connection right now

### 2. `user:offline` fires immediately on disconnect

**Before:** `user:offline` was only emitted when:
- A user explicitly called `end-session`, OR
- The 48-hour reconnect timer expired

**After:** `user:offline` is now **also** emitted immediately when a user's last socket disconnects (network drop, app closed, etc.)

> The session data still stays alive for 48 hours for reconnection — only the **visibility** to other users changes.

### 3. New `user:online` event

When a disconnected user **reconnects** within the grace period, the server now broadcasts `user:online` to the room so the frontend can re-add their marker.

---

## 📱 What You Need To Do (Frontend)

### Step 1: Listen for `user:offline` — Remove marker immediately

You probably already have this, but make sure it **removes the user's marker from the map**:

```typescript
socket.on("user:offline", (data) => {
  // data: { userId: number }
  removeUserMarkerFromMap(data.userId);
});
```

### Step 2: Listen for `user:online` — Re-add marker

This is a **new event**. When a user reconnects after being offline, add their marker back:

```typescript
socket.on("user:online", (data) => {
  // data: { userId: number, lat: number, lng: number, ts: number }
  addOrUpdateUserMarkerOnMap(data.userId, data.lat, data.lng);
});
```

### Step 3: No changes needed for `location:snapshot`

The `location:snapshot` payload format is unchanged — it's still an array of `{ userId, lat, lng, ts }`. The only difference is that it now **excludes disconnected users**, so no frontend code changes are needed.

### Step 4: No changes needed for `location:update`

Real-time location updates from other users work exactly the same as before.

---

## 📋 Quick Checklist

| # | Task | Status |
|---|------|--------|
| 1 | Listen for `user:offline` and **remove** user marker from map | ☐ |
| 2 | Listen for `user:online` (NEW) and **re-add** user marker on map | ☐ |
| 3 | Deploy updated server | ☐ |
| 4 | Test: User A starts session → User B sees marker → User A ends session → marker disappears for User B | ☐ |
| 5 | Test: User A disconnects (kill app) → marker disappears → User A reconnects → marker reappears | ☐ |

---

## 🧪 How to Test

### Test 1: End Session removes marker
1. **User A** starts a session and sends location updates
2. **User B** joins the room and sees User A's marker
3. **User A** emits `end-session`
4. ✅ **User B** should see User A's marker **disappear immediately**

### Test 2: Disconnect removes marker
1. **User A** starts a session and sends location updates
2. **User B** joins the room and sees User A's marker
3. **User A** closes the app / kills the socket
4. ✅ **User B** should see User A's marker **disappear immediately**

### Test 3: Reconnect restores marker
1. Follow Test 2 steps 1–4
2. **User A** reopens the app and emits `reconnect-session`
3. ✅ **User B** should see User A's marker **reappear** at their last known location

### Test 4: New joiner doesn't see ghosts
1. **User A** starts a session, sends locations, then **ends the session**
2. **User C** joins the room
3. ✅ **User C** should see an **empty map** (no stale User A marker)
