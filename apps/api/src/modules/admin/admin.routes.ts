import type { FastifyInstance } from "fastify";
import { platformConfigPatchSchema, type PlatformConfigDto } from "@pablo/shared-types";
import { getPlatformConfig, updatePlatformConfig, PlatformConfigError } from "./platform-config.service.js";
import adminUsersRoutes from "./users.routes.js";
import adminSubscriptionsRoutes from "./subscriptions.routes.js";
import adminHoldersRoutes from "./holders.routes.js";
import adminStatsRoutes from "./stats.routes.js";
import adminLogsRoutes from "./logs.routes.js";
import adminExecutorsRoutes from "./executors.routes.js";

function toDto(config: Awaited<ReturnType<typeof getPlatformConfig>>): PlatformConfigDto {
  return {
    subscriptionPriceUsd: config.subscriptionPriceUsd,
    pabloMintAddress: config.pabloMintAddress,
    minHolderTokens: config.minHolderTokens.toString(),
    subscriptionDurationDays: config.subscriptionDurationDays,
    gracePeriodDays: config.gracePeriodDays,
    treasuryWalletAddress: config.treasuryWalletAddress,
    updatedAt: config.updatedAt.toISOString(),
  };
}

export default async function adminRoutes(fastify: FastifyInstance) {
  fastify.setErrorHandler((error, request, reply) => {
    if (error instanceof PlatformConfigError) {
      request.log.warn({ url: request.url, message: error.message }, "platform_config_error");
      reply.code(error.statusCode).send({ error: "platform_config_error", message: error.message });
      return;
    }
    throw error;
  });

  // Public: the frontend needs the price/mint/treasury to build the
  // subscription UI before the user is even authenticated.
  fastify.get("/config", async () => toDto(await getPlatformConfig()));

  fastify.put(
    "/config",
    { preHandler: [fastify.requireRole("ADMIN")] },
    async (request, reply) => {
      const parsed = platformConfigPatchSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_request", issues: parsed.error.flatten() });
      }
      const updated = await updatePlatformConfig(request.user.sub, parsed.data);
      return toDto(updated);
    },
  );

  // Everything else under /admin is the console proper — authenticated
  // AND role-gated, unlike GET/PUT /config above.
  await fastify.register(async (console) => {
    console.addHook("preHandler", fastify.requireRole("ADMIN"));
    await console.register(adminUsersRoutes, { prefix: "/users" });
    await console.register(adminSubscriptionsRoutes, { prefix: "/subscriptions" });
    await console.register(adminHoldersRoutes, { prefix: "/holders" });
    await console.register(adminStatsRoutes, { prefix: "/stats" });
    await console.register(adminLogsRoutes, { prefix: "/logs" });
    await console.register(adminExecutorsRoutes, { prefix: "/executors" });
  });
}
