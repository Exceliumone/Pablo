import fastifyJwt from "@fastify/jwt";
import fp from "fastify-plugin";
import type { FastifyReply, FastifyRequest } from "fastify";
import { env } from "../config/env.js";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string; role: string };
    user: { sub: string; role: string };
  }
}

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireRole: (role: string) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

/**
 * Registers @fastify/jwt for access-token verification and exposes
 * `fastify.authenticate` / `fastify.requireRole` as preHandlers for
 * protected routes. Wrapped with fastify-plugin so the decorators are
 * visible on the root instance regardless of where this is registered from.
 */
export default fp(async (fastify) => {
  await fastify.register(fastifyJwt, {
    secret: env.JWT_ACCESS_SECRET,
    sign: { expiresIn: env.JWT_ACCESS_TTL },
  });

  fastify.decorate("authenticate", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
    } catch {
      reply.code(401).send({ error: "unauthorized", message: "Invalid or missing access token." });
    }
  });

  // The role check trusts the JWT's `role` claim rather than re-reading the
  // user from the DB — fine given access tokens are short-lived (15m
  // default), a role change simply takes effect on the next refresh.
  fastify.decorate("requireRole", (role: string) => {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await request.jwtVerify();
      } catch {
        reply.code(401).send({ error: "unauthorized", message: "Invalid or missing access token." });
        return;
      }
      if (request.user.role !== role) {
        reply.code(403).send({ error: "forbidden", message: `Requires ${role} role.` });
      }
    };
  });
});
