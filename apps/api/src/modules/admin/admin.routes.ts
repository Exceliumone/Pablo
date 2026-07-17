import type { FastifyInstance } from "fastify";
import { platformConfigPatchSchema, type PlatformConfigDto } from "@pablo/shared-types";
import { getPlatformConfig, updatePlatformConfig } from "./platform-config.service.js";

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
}
