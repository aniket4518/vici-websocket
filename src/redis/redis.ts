// src/config/redis.ts
import { Redis } from "ioredis";
import type { RedisOptions } from "ioredis";
 
const REDIS_URL = process.env.REDIS_URL;

// Shared options for reconnection strategy
const sharedOptions: Partial<RedisOptions> = {
  maxRetriesPerRequest: null,  
  enableReadyCheck: true,
  retryStrategy: (times: number) => {
    if (times > 10) {
      console.error("[Redis] Max retry attempts reached. Giving up.");
      return null;
    }
    const delay = Math.min(times * 100, 3000);
    console.log(`[Redis] Retrying connection in ${delay}ms...`);
    return delay;
  },
  reconnectOnError: (err: Error) => {
    const targetErrors = ["READONLY", "ECONNRESET", "ETIMEDOUT"];
    return targetErrors.some((e) => err.message.includes(e));
  },
   
  ...(REDIS_URL?.startsWith("rediss://") && {
    tls: { rejectUnauthorized: false },
  }),
};

// Main Redis client for general operations
export const redis = REDIS_URL
  ? new Redis(REDIS_URL, sharedOptions)
  : new Redis({ host: "localhost", port: 6379, ...sharedOptions });

// Separate connection for BullMQ (recommended practice)
export const createRedisConnection = (): Redis => {
  return REDIS_URL
    ? new Redis(REDIS_URL, sharedOptions)
    : new Redis({ host: "localhost", port: 6379, ...sharedOptions });
};

redis.on("connect", () => {
  console.log("[Redis] Connected to Redis server");
});

redis.on("ready", () => {
  console.log("[Redis] Redis client ready");
});

redis.on("error", (err: Error) => {
  console.error("[Redis] Redis error:", err.message);
});

redis.on("close", () => {
  console.log("[Redis] Connection closed");
});

redis.on("reconnecting", () => {
  console.log("[Redis] Reconnecting to Redis...");
});

// Graceful shutdown
export async function closeRedisConnection(): Promise<void> {
  try {
    await redis.quit();
    console.log("[Redis] Connection closed gracefully");
  } catch (error) {
    console.error("[Redis] Error closing connection:", error);
    redis.disconnect();
  }
}

export async function checkRedisHealth(): Promise<boolean> {
  try {
    const result = await redis.ping();
    return result === "PONG";
  } catch {
    return false;
  }
}
