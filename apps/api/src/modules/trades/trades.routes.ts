import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { TRADE_SIDES } from "@pablo/shared-types";
import { listTrades } from "./trades.service.js";

const querySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  side: z.enum(TRADE_SIDES).optional(),
});

export default async function tradesRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.authenticate);

  fastify.get("/", async (request, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", issues: parsed.error.flatten() });
    }
    return listTrades(request.user.sub, parsed.data);
  });
}
