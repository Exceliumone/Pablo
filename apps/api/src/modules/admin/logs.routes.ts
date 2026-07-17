import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { listAuditLogs } from "./logs.service.js";

const listQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export default async function adminLogsRoutes(fastify: FastifyInstance) {
  fastify.get("/", async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", issues: parsed.error.flatten() });
    }
    return listAuditLogs(parsed.data);
  });
}
