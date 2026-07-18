"use client";

import { useCallback, useState } from "react";

/** `copied` flips back to false on its own after `resetMs` — callers just
 * render it, no manual reset needed. */
export function useCopyToClipboard(resetMs = 1500) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(
    async (value: string) => {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), resetMs);
    },
    [resetMs],
  );

  return { copied, copy };
}
