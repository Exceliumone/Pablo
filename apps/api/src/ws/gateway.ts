import type { FastifyInstance } from "fastify";
import type { BotEventDto } from "@pablo/shared-types";
import { Redis } from "ioredis";
import { env } from "../config/env.js";

/**
 * The only place apps/api talks to Redis pub/sub for live events — one
 * subscription per connected browser tab, relaying that user's
 * `executor:events:<userId>` channel straight through. Auth comes from a
 * `?token=` query param rather than a header: a native browser WebSocket
 * can't set custom headers on the handshake request.
 */
export default async function wsGateway(fastify: FastifyInstance) {
  fastify.get("/ws", { websocket: true }, (socket, request) => {
    const token = (request.query as Record<string, string | undefined>)?.token;
    if (!token) {
      socket.close(4401, "missing token");
      return;
    }

    let userId: string;
    try {
      const decoded = fastify.jwt.verify<{ sub: string }>(token);
      userId = decoded.sub;
    } catch {
      socket.close(4401, "invalid token");
      return;
    }

    const subscriber = new Redis(env.REDIS_URL);
    const channel = `executor:events:${userId}`;

    subscriber.subscribe(channel).catch((err: unknown) => {
      fastify.log.warn({ err, userId }, "ws: failed to subscribe to redis channel");
    });

    subscriber.on("message", (_channel: string, message: string) => {
      try {
        const event = JSON.parse(message) as BotEventDto;
        socket.send(JSON.stringify(event));
      } catch {
        // Malformed payload from engine-bridge — drop it rather than crash
        // the socket.
      }
    });

    socket.on("close", () => {
      subscriber.unsubscribe(channel).catch(() => undefined);
      subscriber.quit().catch(() => undefined);
    });
  });
}
