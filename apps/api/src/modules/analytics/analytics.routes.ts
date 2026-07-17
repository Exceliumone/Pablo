import type { FastifyInstance } from "fastify";
import { getAnalyticsSummary } from "./analytics.service.js";

export default async function analyticsRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.authenticate);

  fastify.get("/summary", async (request) => getAnalyticsSummary(request.user.sub));
}
