import type { FastifyInstance } from "fastify";
import { getExecutorsOverview } from "./executors.service.js";

export default async function adminExecutorsRoutes(fastify: FastifyInstance) {
  fastify.get("/", async () => getExecutorsOverview());
}
