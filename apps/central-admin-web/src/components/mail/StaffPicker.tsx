"use client";

import { useEffect, useId, useState } from "react";
import { X } from "lucide-react";
import { classifyMailError, searchStaffDirectory } from "@/lib/mail.service";
import type { StaffDirectoryEntry } from "@/types/mail.types";

/** Staff directory search (min 2 chars). Calls onForbidden on 403 so callers can hide it. */
export default function StaffPicker({
  value,
  onChange,
  onForbidden,
}: {
  value: StaffDirectoryEntry | null;
  onChange: (entry: StaffDirectoryEntry | null) => void;
  onForbidden: () => void;
}) {
  const id = useId();
  const listId = `${id}-list`;
  const [text, setText] = useState("");
  const [results, setResults] = useState<StaffDirectoryEntry[]>([]);
  const [active, setActive] = useState(-1);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const q = text.trim();
    if (q.length < 2 || value) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const res = await searchStaffDirectory(q);
        if (!cancelled) {
          setResults(res.slice(0, 10));
          setActive(-1);
          setError(null);
        }
      } catch (err) {
        if (cancelled) return;
        const info = classifyMailError(err);
        if (info.kind === "forbidden") onForbidden();
        else setError(info.message);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [text, value, onForbidden]);

  const visible = text.trim().length < 2 || value ? [] : results;
  const pick = (e: StaffDirectoryEntry) => {
    onChange(e);
    setText("");
    setResults([]);
  };

  if (value) {
    return (
      <span className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-[12px] text-foreground">
        {value.name} <span className="text-muted-foreground">{value.email}</span>
        <button type="button" aria-label="Clear selected employee" onClick={() => onChange(null)} className="ml-auto">
          <X className="h-3.5 w-3.5" />
        </button>
      </span>
    );
  }

  return (
    <div className="relative">
      <input
        id={id}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && visible.length) {
            e.preventDefault();
            setActive((i) => Math.min(i + 1, visible.length - 1));
          } else if (e.key === "ArrowUp" && visible.length) {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter" && active >= 0 && visible[active]) {
            e.preventDefault();
            pick(visible[active]);
          } else if (e.key === "Escape") setResults([]);
        }}
        role="combobox"
        aria-label="Search staff by name or email"
        aria-expanded={visible.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        placeholder="Search staff (min 2 characters)"
        className="w-full rounded-md border border-border bg-card px-3 py-2 text-[12px] outline-none focus:border-primary"
      />
      {error && <p role="alert" className="mt-0.5 text-[11px] font-normal text-red-600">{error}</p>}
      {visible.length > 0 && (
        <ul id={listId} role="listbox" className="absolute left-0 right-0 z-20 mt-1 max-h-56 overflow-auto rounded-md border border-border bg-card shadow-lg">
          {visible.map((e, i) => (
            <li
              key={e.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(ev) => {
                ev.preventDefault();
                pick(e);
              }}
              className={`cursor-pointer px-3 py-1.5 text-[12px] font-normal text-foreground ${i === active ? "bg-primary/10" : "hover:bg-muted"}`}
            >
              {e.name} <span className="text-muted-foreground">{e.email}{e.department ? ` · ${e.department}` : ""}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
