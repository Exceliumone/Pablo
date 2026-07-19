"use client";

import { useEffect, useRef, useState } from "react";
import type {
  BotEventDto,
  NotificationDto,
  NotificationsPageDto,
  TradeDto,
  TradesPageDto,
} from "@pablo/shared-types";
import { apiFetch } from "./api";

const MAX_EVENTS = 100;

function wsUrl(accessToken: string): string {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const wsBase = apiUrl.replace(/^http/, "ws");
  return `${wsBase}/ws?token=${encodeURIComponent(accessToken)}`;
}

/** Redis pub/sub (what the WS gateway relays live) has no history —
 * opportunity/status events really are gone once missed, by design (see
 * event-persister.ts's doc comment: "high-frequency and disposable, not
 * history"). Trades and buy/sell errors ARE durably persisted, though (the
 * latter as `Notification`s with type ERROR — see event-persister.ts and
 * apps/api/src/modules/notifications), so a page refresh doesn't have to
 * lose those: reconstruct synthetic events from GET /trades and
 * GET /notifications?type=ERROR to reseed the feed on mount. */
function tradeToBotEvent(t: TradeDto): Extract<BotEventDto, { type: "trade" }> {
  return {
    type: "trade",
    userId: "",
    side: t.side,
    mint: t.tokenMint,
    dex: t.protocol,
    priceSol: t.priceSol,
    amountSol: t.amountSol,
    amountToken: t.amountToken,
    txSignature: t.txSignature,
    reason: t.reason,
    at: t.createdAt,
  };
}

function notificationToBotEvent(n: NotificationDto): Extract<BotEventDto, { type: "error" }> {
  return {
    type: "error",
    userId: "",
    message: n.body,
    at: n.createdAt,
  };
}

/** Live feed of this user's bot events (opportunity/trade/status/error),
 * relayed by apps/api's WS gateway from the engine's Redis pub/sub channel.
 * Reconnects with backoff — a dropped tab-backgrounded connection shouldn't
 * require a manual page refresh to pick back up.
 *
 * `active` should reflect the bot's own RUNNING/STARTING state, not just
 * "is the user logged in" — otherwise this connects (and the "Flux temps
 * réel" indicator reads Connecté) even while the user's bot is stopped,
 * since the WS gateway's channel exists independently of whether anything
 * is currently publishing to it. Defaults to `true` so callers that don't
 * care about bot state (or haven't been updated yet) keep prior behavior. */
export function useBotEvents(accessToken: string | null, active = true) {
  const [events, setEvents] = useState<BotEventDto[]>([]);
  const [connected, setConnected] = useState(false);
  const retryRef = useRef(0);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;

    void (async () => {
      try {
        const [tradesPage, errorsPage] = await Promise.all([
          apiFetch<TradesPageDto>(`/trades?limit=${MAX_EVENTS}`, { accessToken }),
          apiFetch<NotificationsPageDto>(`/notifications?type=ERROR&limit=${MAX_EVENTS}`, {
            accessToken,
          }).catch(() => ({ notifications: [], nextCursor: null }) as NotificationsPageDto),
        ]);
        if (cancelled) return;
        const seeded = [
          ...tradesPage.trades.map(tradeToBotEvent),
          ...errorsPage.notifications.map(notificationToBotEvent),
        ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
        setEvents((prev) => {
          // Anything already live (arrived while this fetch was in flight)
          // takes priority over its own persisted copy.
          const seenSignatures = new Set(
            prev
              .filter((e): e is Extract<BotEventDto, { type: "trade" }> => e.type === "trade")
              .map((e) => e.txSignature)
              .filter((sig): sig is string => sig !== null),
          );
          const seenErrorKeys = new Set(
            prev
              .filter((e): e is Extract<BotEventDto, { type: "error" }> => e.type === "error")
              .map((e) => `${e.at}:${e.message}`),
          );
          const rest = seeded.filter((e) =>
            e.type === "trade"
              ? !e.txSignature || !seenSignatures.has(e.txSignature)
              : !seenErrorKeys.has(`${e.at}:${e.message}`),
          );
          return [...prev, ...rest]
            .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
            .slice(0, MAX_EVENTS);
        });
      } catch {
        // Best-effort seed only — a failed fetch just leaves the feed
        // empty until live events arrive, same as before this existed.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  useEffect(() => {
    if (!accessToken || !active) {
      // Bot is stopped (or there's no token yet) — ensure the indicator
      // reflects that rather than whatever the last connection left behind.
      setConnected(false);
      return;
    }

    let socket: WebSocket | null = null;
    let closedByEffect = false;
    let retryTimer: ReturnType<typeof setTimeout>;

    function connect() {
      socket = new WebSocket(wsUrl(accessToken!));

      socket.onopen = () => {
        retryRef.current = 0;
        setConnected(true);
      };

      socket.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data) as BotEventDto;
          setEvents((prev) => [parsed, ...prev].slice(0, MAX_EVENTS));
        } catch {
          // ignore malformed frames
        }
      };

      socket.onclose = () => {
        setConnected(false);
        if (closedByEffect) return;
        const delay = Math.min(1000 * 2 ** retryRef.current, 15000);
        retryRef.current += 1;
        retryTimer = setTimeout(connect, delay);
      };
    }

    connect();

    return () => {
      closedByEffect = true;
      clearTimeout(retryTimer);
      socket?.close();
    };
  }, [accessToken, active]);

  return { events, connected };
}
