// src/config/redis.ts
import {Redis}  from "ioredis";
import type { RedisOptions } from "ioredis";
 
const REDIS_HOST = process.env.REDIS_HOST || "localhost";
const REDIS_PORT = parseInt(process.env.REDIS_PORT || "6379", 10);
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || undefined;
const REDIS_DB = parseInt(process.env.REDIS_DB || "0", 10);

// Connection options with reconnection strategy
const redisOptions: RedisOptions = {
  host: REDIS_HOST,
  port: REDIS_PORT,
  ...(REDIS_PASSWORD && { password: REDIS_PASSWORD }),
  db: REDIS_DB,
  maxRetriesPerRequest: null, // Required for BullMQ
  enableReadyCheck: true,
  retryStrategy: (times: number ) => {
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
};

// Main Redis client for general operations
export const redis = new Redis(redisOptions);

// Separate connection for BullMQ (recommended practice)
export const createRedisConnection = (): Redis => {
  return new Redis(redisOptions);
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
