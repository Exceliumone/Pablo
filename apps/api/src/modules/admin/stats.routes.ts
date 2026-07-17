import type { FastifyInstance } from "fastify";
import { getPlatformStats } from "./stats.service.js";

export default async function adminStatsRoutes(fastify: FastifyInstance) {
  fastify.get("/", async () => getPlatformStats());
}
