import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { adminUserPatchDto } from "@pablo/shared-types";
import { AdminUsersError, getUserDetail, listUsers, updateUser } from "./users.service.js";

const listQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export default async function adminUsersRoutes(fastify: FastifyInstance) {
  fastify.setErrorHandler((error, _request, reply) => {
    if (error instanceof AdminUsersError) {
      reply.code(error.statusCode).send({ error: "admin_users_error", message: error.message });
      return;
    }
    throw error;
  });

  fastify.get("/", async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", issues: parsed.error.flatten() });
    }
    return listUsers(parsed.data);
  });

  fastify.get("/:id", async (request) => {
    const { id } = request.params as { id: string };
    return getUserDetail(id);
  });

  fastify.patch(
    "/:id",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = adminUserPatchDto.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_request", issues: parsed.error.flatten() });
      }
      await updateUser(request.user.sub, id, parsed.data);
      return getUserDetail(id);
    },
  );
}
