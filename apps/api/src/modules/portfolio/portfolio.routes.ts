import type { FastifyInstance } from "fastify";
import { getPortfolio } from "./portfolio.service.js";

export default async function portfolioRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.authenticate);

  fastify.get("/", async (request) => getPortfolio(request.user.sub));
}
