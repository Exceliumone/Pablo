import type { FastifyInstance } from "fastify";
import type { PaymentIntentDto, PaymentStatusDto, SubscriptionViewDto } from "@pablo/shared-types";
import { reconcileSubscription, toSubscriptionViewDto } from "./subscription.service.js";
import { createPaymentIntent, checkPaymentIntent, PaymentError } from "./payment.service.js";
import { PlatformConfigError } from "../admin/platform-config.service.js";

function toPaymentIntentDto(
  payment: { id: string; referenceId: string; amountLamports: bigint | null; status: string; expiresAt: Date },
  recipient: string,
  amountSol: number,
  solanaPayUrl: string,
): PaymentIntentDto {
  return {
    id: payment.id,
    reference: payment.referenceId,
    recipient,
    amountSol,
    amountLamports: (payment.amountLamports ?? 0n).toString(),
    solanaPayUrl,
    status: payment.status as PaymentIntentDto["status"],
    expiresAt: payment.expiresAt.toISOString(),
  };
}

export default async function billingRoutes(fastify: FastifyInstance) {
  fastify.setErrorHandler((error, request, reply) => {
    if (error instanceof PaymentError) {
      reply.code(error.statusCode).send({ error: "payment_error", message: error.message });
      return;
    }
    if (error instanceof PlatformConfigError) {
      request.log.warn({ url: request.url, message: error.message }, "platform_config_error");
      reply.code(error.statusCode).send({ error: "platform_config_error", message: error.message });
      return;
    }
    throw error;
  });

  fastify.get(
    "/subscription",
    {
      preHandler: [fastify.authenticate],
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    },
    async (request): Promise<SubscriptionViewDto> => {
      const { subscription, holder } = await reconcileSubscription(request.user.sub);
      return toSubscriptionViewDto(subscription, holder);
    },
  );

  fastify.post(
    "/payment-intent",
    {
      preHandler: [fastify.authenticate],
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (request) => {
      const { payment, solanaPayUrl, recipient, amountSol } = await createPaymentIntent(
        request.user.sub,
      );
      return toPaymentIntentDto(payment, recipient, amountSol, solanaPayUrl);
    },
  );

  fastify.get(
    "/payment-intent/:id",
    {
      preHandler: [fastify.authenticate],
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request): Promise<PaymentStatusDto> => {
      const { id } = request.params as { id: string };
      const payment = await checkPaymentIntent(id, request.user.sub);
      // The frontend already has recipient/amountSol/solanaPayUrl from the
      // POST response and keeps showing those while polling this for the
      // status/txSignature transition — no need to recompute them here.
      return {
        id: payment.id,
        reference: payment.referenceId,
        amountLamports: (payment.amountLamports ?? 0n).toString(),
        status: payment.status as PaymentStatusDto["status"],
        expiresAt: payment.expiresAt.toISOString(),
        txSignature: payment.txSignature,
      };
    },
  );
}
