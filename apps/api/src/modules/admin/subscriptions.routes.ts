import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { adminGrantRequestDto, SUBSCRIPTION_STATUSES } from "@pablo/shared-types";
import {
  AdminSubscriptionsError,
  grantPremium,
  listSubscriptions,
  revokePremium,
} from "./subscriptions.service.js";

const listQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(SUBSCRIPTION_STATUSES).optional(),
});

export default async function adminSubscriptionsRoutes(fastify: FastifyInstance) {
  fastify.setErrorHandler((error, _request, reply) => {
    if (error instanceof AdminSubscriptionsError) {
      reply.code(error.statusCode).send({ error: "admin_subscriptions_error", message: error.message });
      return;
    }
    throw error;
  });

  fastify.get("/", async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", issues: parsed.error.flatten() });
    }
    return listSubscriptions(parsed.data);
  });

  fastify.post(
    "/:id/grant",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = adminGrantRequestDto.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_request", issues: parsed.error.flatten() });
      }
      await grantPremium(request.user.sub, id, parsed.data.days);
      return { ok: true };
    },
  );

  fastify.post(
    "/:id/revoke",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request) => {
      const { id } = request.params as { id: string };
      await revokePremium(request.user.sub, id);
      return { ok: true };
    },
  );
}
