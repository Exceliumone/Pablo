import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";

/**
 * Every admin-actuated change (role/status changes, subscription
 * grants/revokes, PlatformConfig edits) lands here — this is what backs
 * GET /admin/logs. Best-effort: a logging failure must never block the
 * action it's describing, so this only ever warns to stderr, never throws.
 *
 * `actorType: "USER"` covers a sensitive action a user takes on their own
 * account outside the admin console (e.g. exporting their custodial
 * trading wallet's private key) — same durable trail, not shown in
 * GET /admin/logs' own filters yet but queryable the same way.
 */
export async function logAudit(entry: {
  actorType: "USER" | "ADMIN" | "SYSTEM";
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
