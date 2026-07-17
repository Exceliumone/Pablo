import type { FastifyInstance } from "fastify";
import { botSettingsSchema } from "@pablo/shared-types";
import {
  BotError,
  getBotSettings,
  getBotStatus,
  startBot,
  stopBot,
  updateBotSettings,
} from "./bot.service.js";

const botSettingsPatchSchema = botSettingsSchema.partial().omit({ isActive: true });

export default async function botRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.authenticate);

  fastify.setErrorHandler((error, _request, reply) => {
    if (error instanceof BotError) {
      reply.code(error.statusCode).send({ error: "bot_error", message: error.message });
      return;
    }
    throw error;
  });

  fastify.get("/settings", async (request) => getBotSettings(request.user.sub));

  fastify.put("/settings", async (request, reply) => {
    const parsed = botSettingsPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", issues: parsed.error.flatten() });
    }
    return updateBotSettings(request.user.sub, parsed.data);
  });

  fastify.post(
    "/start",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request) => startBot(request.user.sub),
  );

  fastify.post(
    "/stop",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request) => stopBot(request.user.sub),
  );

  fastify.get("/status", async (request) => getBotStatus(request.user.sub));
}
