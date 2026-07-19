import type { NotificationDto, NotificationsPageDto, NotificationType } from "@pablo/shared-types";
import { prisma } from "../../lib/prisma.js";

function toNotificationDto(n: {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  readAt: Date | null;
  createdAt: Date;
}): NotificationDto {
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    readAt: n.readAt ? n.readAt.toISOString() : null,
    createdAt: n.createdAt.toISOString(),
  };
}

export interface ListNotificationsOptions {
  cursor?: string;
  limit: number;
  type?: NotificationType;
}

/** Cursor pagination, same rationale as trades.service.ts's listTrades — a
 * live-growing notification list never skips or repeats rows as new ones
 * land between page fetches. */
export async function listNotifications(
  userId: string,
  opts: ListNotificationsOptions,
): Promise<NotificationsPageDto> {
  const notifications = await prisma.notification.findMany({
    where: {
      userId,
      ...(opts.type ? { type: opts.type } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: opts.limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  });

  const hasMore = notifications.length > opts.limit;
  const page = hasMore ? notifications.slice(0, opts.limit) : notifications;
  const lastRow = page.at(-1);

  return {
    notifications: page.map(toNotificationDto),
    nextCursor: hasMore && lastRow ? lastRow.id : null,
  };
}
