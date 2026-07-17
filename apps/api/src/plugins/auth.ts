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
  }
}

/**
 * Registers @fastify/jwt for access-token verification and exposes
 * `fastify.authenticate` as a preHandler for protected routes. Wrapped with
 * fastify-plugin so the decorator is visible on the root instance regardless
 * of where this is registered from.
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
});
