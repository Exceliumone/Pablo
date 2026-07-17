import type { FastifyInstance } from "fastify";
import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import { nonceQuerySchema, verifySchema } from "./auth.schemas.js";
import {
  AuthError,
  createSession,
  issueNonce,
  revokeSession,
  rotateSession,
  verifyAndResolveWallet,
} from "./auth.service.js";

const REFRESH_COOKIE = "pablo_refresh";

function setRefreshCookie(reply: import("fastify").FastifyReply, token: string, expiresAt: Date) {
  reply.setCookie(REFRESH_COOKIE, token, {
    path: env.AUTH_COOKIE_PATH,
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    expires: expiresAt,
  });
}

/** Logs+sends a 400 for a failed zod parse — the manual `if (!parsed.success)`
 * branches below don't throw, so they'd otherwise bypass the AuthError
 * warn log above and vanish from `pm2 logs` entirely. */
function invalidRequest(
  request: import("fastify").FastifyRequest,
  reply: import("fastify").FastifyReply,
  issues: unknown,
) {
  request.log.warn({ url: request.url, issues }, "auth_invalid_request");
  return reply.code(400).send({ error: "invalid_request", issues });
}

async function userPayload(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    include: { wallets: true, subscription: true },
  });
  return {
    id: user.id,
    role: user.role,
    status: user.status,
    wallets: user.wallets.map((w) => ({
      address: w.address,
      provider: w.provider,
      isPrimary: w.isPrimary,
    })),
    subscription: user.subscription
      ? { tier: user.subscription.tier, status: user.subscription.status }
      : null,
  };
}

export default async function authRoutes(fastify: FastifyInstance) {
  fastify.setErrorHandler((error, request, reply) => {
    if (error instanceof AuthError) {
      // AuthError is an expected outcome (bad signature, expired nonce, a
      // banned account, ...) and was previously never logged — only truly
      // unhandled errors hit the app-level handler that does log. That
      // made "why did sign-in fail" undebuggable from `pm2 logs` alone,
      // since the client only ever saw the JSON response. warn (not
      // error): these are routine auth outcomes, not bugs.
      request.log.warn(
        { url: request.url, statusCode: error.statusCode, message: error.message },
        "auth_error",
      );
      reply.code(error.statusCode).send({ error: "auth_error", message: error.message });
      return;
    }
    throw error;
  });

  fastify.get("/nonce", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request, reply) => {
    const parsed = nonceQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return invalidRequest(request, reply, parsed.error.flatten());
    }
    const result = await issueNonce(parsed.data.address);
    return result;
  });

  fastify.post("/verify", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    const parsed = verifySchema.safeParse(request.body);
    if (!parsed.success) {
      return invalidRequest(request, reply, parsed.error.flatten());
    }

    const { userId } = await verifyAndResolveWallet(parsed.data);
    const session = await createSession(userId, {
      userAgent: request.headers["user-agent"],
      ip: request.ip,
    });
    setRefreshCookie(reply, session.refreshToken, session.expiresAt);

    const user = await userPayload(userId);
    const accessToken = await reply.jwtSign({ sub: userId, role: user.role });
    return { accessToken, user };
  });

  fastify.post("/refresh", async (request, reply) => {
    const token = request.cookies[REFRESH_COOKIE];
    if (!token) {
      // The single most useful log line for "refresh silently doesn't
      // work": if this fires on every request even right after a
      // successful /auth/verify, the refresh cookie isn't reaching the
      // browser's cookie jar for this path at all — check AUTH_COOKIE_PATH
      // against whatever prefix a reverse proxy strips before this app
      // ever sees the request (see env.ts).
      request.log.warn({ url: request.url, cookiesSeen: Object.keys(request.cookies) }, "auth_refresh_no_cookie");
      return reply.code(401).send({ error: "auth_error", message: "No session cookie." });
    }
    const { user, refreshToken, expiresAt } = await rotateSession(token, {
      userAgent: request.headers["user-agent"],
      ip: request.ip,
    });
    setRefreshCookie(reply, refreshToken, expiresAt);
    const accessToken = await reply.jwtSign({ sub: user.id, role: user.role });
    return { accessToken };
  });

  fastify.post("/logout", async (request, reply) => {
    const token = request.cookies[REFRESH_COOKIE];
    if (token) {
      await revokeSession(token);
    }
    reply.clearCookie(REFRESH_COOKIE, { path: env.AUTH_COOKIE_PATH });
    return { ok: true };
  });

  fastify.post(
    "/wallets/link",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const parsed = verifySchema.safeParse(request.body);
      if (!parsed.success) {
        return invalidRequest(request, reply, parsed.error.flatten());
      }
      const { sub } = request.user;
      await verifyAndResolveWallet(parsed.data, sub);
      return userPayload(sub);
    },
  );

  fastify.get("/me", { preHandler: [fastify.authenticate] }, async (request) => {
    return userPayload(request.user.sub);
  });
}
