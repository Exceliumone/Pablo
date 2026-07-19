import type { FastifyInstance } from "fastify";
import { closePosition, getPortfolio, PortfolioError } from "./portfolio.service.js";

export default async function portfolioRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.authenticate);

  fastify.setErrorHandler((error, _request, reply) => {
    if (error instanceof PortfolioError) {
      reply.code(error.statusCode).send({ error: "portfolio_error", message: error.message });
      return;
    }
    throw error;
  });

  fastify.get("/", async (request) => getPortfolio(request.user.sub));

  fastify.post(
    "/positions/:id/close",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request) => {
      const { id } = request.params as { id: string };
      await closePosition(request.user.sub, id);
      return { accepted: true };
    },
  );
}
