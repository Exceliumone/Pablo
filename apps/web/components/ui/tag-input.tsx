"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/** A free-form list input — type a value, press Enter (or comma) to add it
 * as a removable chip. Backspace on an empty draft removes the last chip,
 * matching the usual "email recipients" / "tags" interaction. */
export function TagInput({
  values,
  onChange,
  placeholder,
  className,
}: {
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  className?: string;
}) {
  const [draft, setDraft] = useState("");

  function commit() {
    const value = draft.trim();
    if (value && !values.includes(value)) {
      onChange([...values, value]);
    }
    setDraft("");
  }

  function remove(value: string) {
    onChange(values.filter((v) => v !== value));
  }

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-1.5 rounded-md border border-surface-border/20 bg-white/[0.03] px-2 py-1.5 transition-colors focus-within:border-pablo-500/50",
        className,
      )}
    >
      {values.map((value) => (
        <span
          key={value}
          className="text-tabular inline-flex items-center gap-1 rounded bg-pablo-500/10 px-2 py-1 text-xs text-pablo-200"
        >
          <span className="max-w-[10rem] truncate" title={value}>
            {value}
          </span>
          <button
            type="button"
            onClick={() => remove(value)}
            className="text-pablo-300/70 transition-colors hover:text-pablo-100"
            aria-label={`Retirer ${value}`}
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commit();
          } else if (e.key === "Backspace" && draft === "" && values.length > 0) {
            remove(values[values.length - 1]);
          }
        }}
        onBlur={commit}
        placeholder={values.length === 0 ? placeholder : undefined}
        className="min-w-[8rem] flex-1 bg-transparent py-1 text-sm text-foreground outline-none"
      />
    </div>
  );
}
