# 🏃 Vici WebSocket Server - Frontend Integration Guide

> Real-time multi-user location tracking for the Vici running app

## 📖 Overview

This WebSocket server enables real-time location sharing between users during running sessions. Users can:

- **Connect & Join Rooms** - Connect to the server and join a room to see other active runners
- **View Other Runners** - See all currently active users on a map in real-time
- **Start Sessions** - Begin a running session to share their location with others
- **Track Their Path** - Store location updates locally to render their running path
- **End Sessions** - Stop sharing location when finished running

---

## 🔌 Connection

### Endpoint

```
ws://YOUR_SERVER_HOST:3000
```

### Authentication

The server requires JWT authentication. You can provide the token in two ways:

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

```typescript
interface JwtPayload {
  userId: number;   // Required: The unique user identifier
  iat?: number;     // Issued at timestamp
  exp?: number;     // Expiration timestamp
}
```

### Connection Errors

If authentication fails, the connection will be rejected with an error:

```typescript
socket.on("connect_error", (error) => {
  if (error.message === "UNAUTHORIZED") {
    // Handle unauthorized access - token missing, invalid, or expired
  }
});
```

---

## 🎯 User Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              USER FLOW DIAGRAM                              │
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

Join a room to receive location updates from other active users.

```typescript
// Request
socket.emit("join-room", roomId: string);

// Example
socket.emit("join-room", "central-park-runners");
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `roomId` | `string` | ✅ | Any unique string identifier for the room |

**Response:** Immediately receive `location:snapshot` event (see below)

---

### 2. `start-session`

Start a running session to begin sending your location to other users.

```typescript
// Request
socket.emit("start-session", {
  roomId: string,
  sessionId: number
});

// Example
socket.emit("start-session", {
  roomId: "central-park-runners",
  sessionId: 12345  // Obtained from Express server
});
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `roomId` | `string` | ✅ | Must match the room you joined earlier |
| `sessionId` | `number` | ✅ | Session ID from your Express backend |

> ⚠️ **Important:** You must call `join-room` before `start-session`. If `roomId` or `sessionId` is missing, the request is silently ignored.

---

### 3. `location:update`

Send your current location. **Only works after `start-session`.** Updates are silently ignored if no active session exists.

```typescript
// Request
socket.emit("location:update", {
  lat: number,
  lng: number
});

// Example
socket.emit("location:update", {
  lat: 40.785091,
  lng: -73.968285
});
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `lat` | `number` | ✅ | Latitude coordinate |
| `lng` | `number` | ✅ | Longitude coordinate |

> 💡 **Tip:** Store these updates locally in your app to render the user's path on the map during the session. The server also persists location points in Redis under the key `session:{sessionId}:path` for later retrieval.

---

### 4. `end-session`

End your running session. Stops broadcasting your location.

```typescript
// Request (no payload needed)
socket.emit("end-session");
```

---

## 📥 Server → Client Events

### 1. `location:snapshot`

Received immediately after `join-room`. Contains all currently active users with their last known location.

```typescript
socket.on("location:snapshot", (snapshot) => {
  // Handle active users
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

// Example
[
  { userId: 1, lat: 40.785091, lng: -73.968285, ts: 1706636270000 },
  { userId: 2, lat: 40.782865, lng: -73.965355, ts: 1706636268000 },
  { userId: 3, lat: 40.779437, lng: -73.963244, ts: 1706636265000 }
]
```

---

### 2. `location:update`

Received when another user in the room sends a location update.

```typescript
socket.on("location:update", (data) => {
  // Update user's position on map
});
```

**Payload:**

```typescript
interface LocationUpdate {
  userId: number;  // The user who sent this update
  lat: number;
  lng: number;
  ts: number;      // Unix timestamp (milliseconds)
}

// Example
{ userId: 5, lat: 40.785091, lng: -73.968285, ts: 1706636270000 }
```

---

### 3. `user:offline`

Received when a user ends their session or disconnects.

```typescript
socket.on("user:offline", (data) => {
  // Remove user from map
});
```

**Payload:**

```typescript
interface UserOffline {
  userId: number;
}

// Example
{ userId: 5 }
```

---

> ⚠️ **Note:** The server does **not** emit explicit error events for validation failures. If a required field is missing (e.g., `roomId` for `join-room`, or `roomId`/`sessionId` for `start-session`), the request is silently ignored. Always ensure payloads are correctly structured before emitting.

---

## 📋 TypeScript Types

Here are all the types you'll need for your frontend implementation:

```typescript
// ============ CONNECTION ============

interface SocketAuth {
  token: string;  // JWT token
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

// ============ SERVER → CLIENT EVENTS ============

// Location point (common type)
interface LocationPoint {
  lat: number;
  lng: number;
  ts: number;  // Unix timestamp in milliseconds
}

// location:snapshot
interface UserLocation extends LocationPoint {
  userId: number;
}
type LocationSnapshotPayload = UserLocation[];  // Nulls are filtered server-side

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
```

---

## 🗺️ Events Summary Table

| Event | Direction | When to Use | Payload |
|-------|-----------|-------------|---------|
| `join-room` | Client → Server | After connecting, to join a tracking room | `roomId: string` |
| `start-session` | Client → Server | When user starts a running session | `{ roomId, sessionId }` |
| `location:update` | Client → Server | During active session, to share location | `{ lat, lng }` |
| `end-session` | Client → Server | When user ends running session | *none* |
| `location:snapshot` | Server → Client | After joining room, all active users | `[{ userId, lat, lng, ts }, ...]` |
| `location:update` | Server → Client | Real-time location from other users | `{ userId, lat, lng, ts }` |
| `user:offline` | Server → Client | When another user ends/disconnects | `{ userId }` |

---

## 💻 Complete Implementation Example

```typescript
import { io, Socket } from "socket.io-client";

class ViciSocketService {
  private socket: Socket | null = null;
  private localPath: Array<{ lat: number; lng: number; ts: number }> = [];

  // 1. Connect to server
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

      // Set up event listeners
      this.setupEventListeners();
    });
  }

  // 2. Join a room
  joinRoom(roomId: string): void {
    this.socket?.emit("join-room", roomId);
  }

  // 3. Start session
  startSession(roomId: string, sessionId: number): void {
    this.localPath = [];  // Reset local path
    this.socket?.emit("start-session", { roomId, sessionId });
  }

  // 4. Send location update
  sendLocation(lat: number, lng: number): void {
    const point = { lat, lng, ts: Date.now() };
    
    // Store locally for path rendering
    this.localPath.push(point);
    
    // Send to server
    this.socket?.emit("location:update", { lat, lng });
  }

  // 5. End session
  endSession(): void {
    this.socket?.emit("end-session");
  }

  // 6. Disconnect
  disconnect(): void {
    this.socket?.disconnect();
    this.socket = null;
  }

  // Get local path for rendering
  getLocalPath() {
    return this.localPath;
  }

  private setupEventListeners(): void {
    if (!this.socket) return;

    // Receive initial snapshot of active users
    this.socket.on("location:snapshot", (snapshot) => {
      console.log("Active users:", snapshot);
      // Render all active users on the map
    });

    // Receive real-time location updates
    this.socket.on("location:update", (data) => {
      console.log("User location update:", data);
      // Update user position on map
    });

    // Handle user going offline
    this.socket.on("user:offline", (data) => {
      console.log("User went offline:", data.userId);
      // Remove user from map
    });
  }
}

// Usage
async function main() {
  const vici = new ViciSocketService();
  
  // Connect with JWT token
  await vici.connect("your-jwt-token");
  
  // Join a room to see other runners
  vici.joinRoom("morning-runners");
  
  // When user taps "Start Run" button
  vici.startSession("morning-runners", 12345);
  
  // During the run, periodically send location
  // (typically from GPS/location service)
  vici.sendLocation(40.785091, -73.968285);
  
  // When user taps "End Run" button
  vici.endSession();
  
  // Get the path for analytics display
  const runPath = vici.getLocalPath();
}
```

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
              │   IN ROOM        │◀────────────┐
              │ (spectator mode) │             │
              └────────┬─────────┘             │
                       │                       │
              start-session(...)          end-session
                       │                       │
                       ▼                       │
              ┌──────────────────┐             │
              │  ACTIVE SESSION  │─────────────┘
              │  (sending locs)  │
              └──────────────────┘
```

---

## ⚠️ Important Notes

1. **Order Matters**: Always `join-room` before `start-session`
2. **Local Storage**: Store your own location updates locally for path rendering - the server stores them in Redis (key: `session:{sessionId}:path`) but doesn't send them back to you
3. **Reconnection**: If disconnected mid-session, you'll need to reconnect, rejoin room, and restart session
4. **Session ID**: Must be obtained from your Express backend before starting a session
5. **Multiple Devices**: The same user can connect from multiple devices/sockets — sockets are tracked per user per room
6. **Auto-cleanup**: If connection drops, other users receive `user:offline` automatically (only when all of a user's sockets disconnect)
7. **Silent Validation**: The server silently ignores malformed requests (missing `roomId`, `sessionId`, etc.) — no error event is emitted

---

## 📡 Server Information

- **Protocol**: WebSocket (Socket.IO)
- **Default Port**: 3000
- **Authentication**: JWT via handshake auth or headers
- **Data Storage**: Location points are stored in Redis (TTL: 6 hours)
