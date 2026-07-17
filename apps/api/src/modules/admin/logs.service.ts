import type { AuditLogDto, AuditLogsPageDto } from "@pablo/shared-types";
import { prisma } from "../../lib/prisma.js";

export interface ListLogsOptions {
  cursor?: string;
  limit: number;
}

function toDto(row: {
  id: string;
  actorType: string;
  userId: string | null;
  action: string;
  meta: unknown;
  createdAt: Date;
}): AuditLogDto {
  return {
    id: row.id,
    actorType: row.actorType,
    actorUserId: row.userId,
    action: row.action,
    meta: (row.meta as Record<string, unknown> | null) ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listAuditLogs(opts: ListLogsOptions): Promise<AuditLogsPageDto> {
  const rows = await prisma.auditLog.findMany({
    orderBy: { createdAt: "desc" },
    take: opts.limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > opts.limit;
  const page = hasMore ? rows.slice(0, opts.limit) : rows;
  const lastRow = page.at(-1);

  return {
    logs: page.map(toDto),
    nextCursor: hasMore && lastRow ? lastRow.id : null,
  };
}
