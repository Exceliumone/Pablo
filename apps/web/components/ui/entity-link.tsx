"use client";

import { Check, Copy, ExternalLink } from "lucide-react";
import { useCopyToClipboard } from "@/lib/use-copy-to-clipboard";
import { solscanUrl, type ExplorerKind } from "@/lib/explorer";
import { cn } from "@/lib/utils";

function truncate(value: string, lead = 4, tail = 4): string {
  if (value.length <= lead + tail + 1) return value;
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

/** A tx signature / wallet address / token mint rendered as a Solscan link
 * plus a copy button — the one place all three views (live activity,
 * portfolio, history) get this from, so "clickable and copyable" means the
 * same thing everywhere. `label` overrides the truncated value itself (e.g.
 * a known token symbol) while `value` still drives the link + copy. */
export function EntityLink({
  kind,
  value,
  label,
  className,
}: {
  kind: ExplorerKind;
  value: string;
  label?: string;
  className?: string;
}) {
  const { copied, copy } = useCopyToClipboard();

  return (
    <span className={cn("text-tabular inline-flex min-w-0 items-center gap-1", className)}>
      <a
        href={solscanUrl(kind, value)}
        target="_blank"
        rel="noreferrer noopener"
        title={value}
        className="inline-flex min-w-0 items-center gap-0.5 truncate text-inherit underline-offset-2 hover:text-pablo-300 hover:underline"
      >
        <span className="truncate">{label ?? truncate(value)}</span>
        <ExternalLink className="h-3 w-3 shrink-0 opacity-60" />
      </a>
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          void copy(value);
        }}
        title="Copier"
        aria-label="Copier"
        className="shrink-0 text-muted-foreground transition-colors hover:text-pablo-300"
      >
        {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
      </button>
    </span>
  );
}
