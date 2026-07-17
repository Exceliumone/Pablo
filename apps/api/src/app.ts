import Fastify, { type FastifyError } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { env } from "./config/env.js";
import authPlugin from "./plugins/auth.js";
import authRoutes from "./modules/auth/auth.routes.js";
import adminRoutes from "./modules/admin/admin.routes.js";
import billingRoutes from "./modules/billing/billing.routes.js";
import botRoutes from "./modules/bot/bot.routes.js";
import portfolioRoutes from "./modules/portfolio/portfolio.routes.js";
import tradesRoutes from "./modules/trades/trades.routes.js";
import analyticsRoutes from "./modules/analytics/analytics.routes.js";
import walletRoutes from "./modules/wallet/wallet.routes.js";
import wsGateway from "./ws/gateway.js";

export function buildApp() {
  const app = Fastify({
    logger:
      env.NODE_ENV === "development"
        ? { transport: { target: "pino-pretty" } }
        : env.NODE_ENV === "test"
          ? false
          : true,
  });

  app.register(helmet);
  app.register(cors, { origin: env.APP_ORIGIN, credentials: true });
  app.register(rateLimit, { max: 100, timeWindow: "1 minute" });
  app.register(cookie);
  app.register(authPlugin);
  app.register(websocket);

  // Final safety net: module-level handlers (auth.routes.ts, billing.routes.ts)
  // catch their own typed errors and re-throw everything else, which lands
  // here. Anything unrecognized becomes a generic message — an upstream RPC
  // outage or a stray DB error should never leak internal detail (hostnames,
  // driver messages, stack traces) to the client, only to the server log.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error({ err: error }, "unhandled error");
    const statusCode =
      typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500
        ? error.statusCode
        : 500;
    if (statusCode >= 500) {
      reply.code(statusCode).send({
        error: "internal_error",
        message: "Something went wrong on our end. Please try again shortly.",
      });
      return;
    }
    reply.code(statusCode).send({ error: "bad_request", message: error.message });
  });

  app.get("/health", async () => ({ status: "ok", service: "pablo-api" }));

  app.register(authRoutes, { prefix: "/auth" });
  app.register(adminRoutes, { prefix: "/admin" });
  app.register(billingRoutes, { prefix: "/billing" });
  app.register(botRoutes, { prefix: "/bot" });
  app.register(portfolioRoutes, { prefix: "/portfolio" });
  app.register(tradesRoutes, { prefix: "/trades" });
  app.register(analyticsRoutes, { prefix: "/analytics" });
  app.register(walletRoutes, { prefix: "/wallet" });
  app.register(wsGateway);

  // Domain modules are registered here as they land, one phase at a time:
  // Phase 1 → auth (done). Phase 2 → billing + PlatformConfig admin (done).
  // Phase 3 → bot control + engine-bridge orchestration + WS gateway
  // (done). Phase 4 → portfolio/trades/analytics/wallet (done). Phase 5 →
  // full admin console (users, holders, licenses, stats, logs, monitoring).

  return app;
}
