"use client";

import { useEffect, useRef, useState } from "react";
import type { BotEventDto } from "@pablo/shared-types";

const MAX_EVENTS = 100;

function wsUrl(accessToken: string): string {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const wsBase = apiUrl.replace(/^http/, "ws");
  return `${wsBase}/ws?token=${encodeURIComponent(accessToken)}`;
}

/** Live feed of this user's bot events (opportunity/trade/status/error),
 * relayed by apps/api's WS gateway from the engine's Redis pub/sub channel.
 * Reconnects with backoff — a dropped tab-backgrounded connection shouldn't
 * require a manual page refresh to pick back up. */
export function useBotEvents(accessToken: string | null) {
  const [events, setEvents] = useState<BotEventDto[]>([]);
  const [connected, setConnected] = useState(false);
  const retryRef = useRef(0);

  useEffect(() => {
    if (!accessToken) return;

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
  }, [accessToken]);

  return { events, connected };
}
