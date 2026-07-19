import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { NOTIFICATION_TYPES } from "@pablo/shared-types";
import { listNotifications } from "./notification.service.js";

const querySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  type: z.enum(NOTIFICATION_TYPES).optional(),
});

/** Backs the persisted half of the Sniper page's live activity feed — see
 * apps/web/lib/use-bot-events.ts, which seeds `type=ERROR` on mount so a
 * page refresh doesn't lose track of recent buy/sell failures the way the
 * ephemeral WebSocket stream alone would (opportunity/status events stay
 * ephemeral-only, matching event-persister.ts's own scope). */
export default async function notificationRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.authenticate);

  fastify.get("/", async (request, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", issues: parsed.error.flatten() });
    }
    return listNotifications(request.user.sub, parsed.data);
  });
}
