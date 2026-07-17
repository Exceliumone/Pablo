import type { FastifyInstance } from "fastify";
import { withdrawRequestDto } from "@pablo/shared-types";
import { WalletError, getWalletView, withdrawFromTradingWallet } from "./wallet.service.js";

export default async function walletRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.authenticate);

  fastify.setErrorHandler((error, _request, reply) => {
    if (error instanceof WalletError) {
      reply.code(error.statusCode).send({ error: "wallet_error", message: error.message });
      return;
    }
    throw error;
  });

  fastify.get("/", async (request) => getWalletView(request.user.sub));

  fastify.post(
    "/withdraw",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsed = withdrawRequestDto.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_request", issues: parsed.error.flatten() });
      }
      const txSignature = await withdrawFromTradingWallet(
        request.user.sub,
        parsed.data.toAddress,
        parsed.data.amountSol,
      );
      return { txSignature };
    },
  );
}
