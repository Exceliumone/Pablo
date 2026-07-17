import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";

/**
 * Every admin-actuated change (role/status changes, subscription
 * grants/revokes, PlatformConfig edits) lands here — this is what backs
 * GET /admin/logs. Best-effort: a logging failure must never block the
 * action it's describing, so this only ever warns to stderr, never throws.
 */
export async function logAudit(entry: {
  actorType: "ADMIN" | "SYSTEM";
  actorUserId?: string | null;
  action: string;
  meta?: Record<string, unknown>;
}) {
  try {
    await prisma.auditLog.create({
      data: {
        actorType: entry.actorType,
        userId: entry.actorUserId ?? null,
        action: entry.action,
        meta: (entry.meta as Prisma.InputJsonValue) ?? undefined,
      },
    });
  } catch (err) {
    console.warn("logAudit: failed to write audit log entry", err);
  }
}
