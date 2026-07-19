import type { FastifyInstance } from "fastify";
import { withdrawRequestDto } from "@pablo/shared-types";
import {
  WalletError,
  exportTradingWalletPrivateKey,
  getWalletView,
  getWithdrawalQuote,
  withdrawFromTradingWallet,
} from "./wallet.service.js";

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

  fastify.get("/withdraw-quote", async (request) => getWithdrawalQuote(request.user.sub));

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

  // Tighter than /withdraw's 5/min — a withdrawal is a bounded, one-time,
  // auditable on-chain transfer; exporting the raw key hands over
  // permanent, unbounded control of the wallet with no way to revoke it
  // after the fact.
  fastify.post(
    "/export-key",
    { config: { rateLimit: { max: 3, timeWindow: "1 minute" } } },
    async (request) => exportTradingWalletPrivateKey(request.user.sub),
  );
}
