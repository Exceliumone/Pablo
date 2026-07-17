import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { env } from "./config/env.js";

export function buildApp() {
  const app = Fastify({
    logger:
      env.NODE_ENV === "development"
        ? { transport: { target: "pino-pretty" } }
        : true,
  });

  app.register(helmet);
  app.register(cors, { origin: env.NODE_ENV === "development" });
  app.register(rateLimit, { max: 100, timeWindow: "1 minute" });

  app.get("/health", async () => ({ status: "ok", service: "pablo-api" }));

  // Domain modules are registered here as they land, one phase at a time:
  // Phase 1 → auth. Phase 2 → billing. Phase 3 → sniper/settings (engine-bridge
  // proxy). Phase 4 → portfolio/trades/notifications + WS gateway. Phase 5 → admin.

  return app;
}
