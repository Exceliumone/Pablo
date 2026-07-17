import { Redis } from "ioredis";
import { env } from "../config/env.js";

export const redis = new Redis(env.REDIS_URL, {
  // Fail fast in dev instead of buffering commands silently against a dead
  // connection — surfaces a misconfigured REDIS_URL immediately.
  maxRetriesPerRequest: 3,
});
