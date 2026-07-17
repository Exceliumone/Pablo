import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { env } from "./config/env.js";
import authPlugin from "./plugins/auth.js";
import authRoutes from "./modules/auth/auth.routes.js";

export function buildApp() {
  const app = Fastify({
    logger:
      env.NODE_ENV === "development"
        ? { transport: { target: "pino-pretty" } }
        : true,
  });

  app.register(helmet);
  app.register(cors, { origin: env.APP_ORIGIN, credentials: true });
  app.register(rateLimit, { max: 100, timeWindow: "1 minute" });
  app.register(cookie);
  app.register(authPlugin);

  app.get("/health", async () => ({ status: "ok", service: "pablo-api" }));

  app.register(authRoutes, { prefix: "/auth" });

  // Domain modules are registered here as they land, one phase at a time:
  // Phase 1 → auth (done). Phase 2 → billing. Phase 3 → sniper/settings
  // (engine-bridge proxy). Phase 4 → portfolio/trades/notifications + WS
  // gateway. Phase 5 → admin.

  return app;
}
