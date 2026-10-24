"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search, SlidersHorizontal, X } from "lucide-react";
import { isTypingTarget } from "./mail-utils";

const ADVANCED = ["from", "to", "subject", "after", "before"] as const;

export default function MailSearch() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const inputRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState(params.get("q") ?? "");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [advanced, setAdvanced] = useState<Record<string, string>>(() =>
    Object.fromEntries(ADVANCED.map((k) => [k, params.get(k) ?? ""])),
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && !isTypingTarget(e.target) && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    const next = new URLSearchParams();
    if (q.trim()) next.set("q", q.trim());
    for (const k of ADVANCED) if (advanced[k]?.trim()) next.set(k, advanced[k].trim());
    // Results are always mailbox scoped by the server; leave thread view.
    const listPath = pathname.split("/thread/")[0];
    router.push(next.toString() ? `${listPath}?${next.toString()}` : listPath);
  };

  const clear = () => {
    setQ("");
    setAdvanced(Object.fromEntries(ADVANCED.map((k) => [k, ""])));
    router.push(pathname.split("/thread/")[0]);
  };

  return (
    <form role="search" onSubmit={submit} className="flex flex-col gap-2">
      <div className="flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1.5 focus-within:border-primary">
        <Search className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <label htmlFor="mail-search" className="sr-only">Search mail</label>
        <input
          id="mail-search"
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search mail ( / )"
          className="min-w-0 flex-1 bg-transparent text-[12px] outline-none"
        />
        {(q || params.get("q")) && (
          <button type="button" onClick={clear} aria-label="Clear search" className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        )}
        <button
          type="button"
          onClick={() => setShowAdvanced((s) => !s)}
          aria-expanded={showAdvanced}
          aria-controls="mail-search-advanced"
          aria-label="Advanced search"
          className="text-muted-foreground hover:text-foreground"
        >
          <SlidersHorizontal className="h-4 w-4" />
        </button>
      </div>
      {showAdvanced && (
        <div id="mail-search-advanced" className="grid grid-cols-2 gap-2 rounded-md border border-border bg-card p-2">
          {ADVANCED.map((k) => (
            <label key={k} className="flex flex-col gap-0.5 text-[10px] font-semibold uppercase text-muted-foreground">
              {k}
              <input
                type={k === "after" || k === "before" ? "date" : "text"}
                value={advanced[k]}
                onChange={(e) => setAdvanced((a) => ({ ...a, [k]: e.target.value }))}
                className="rounded border border-border bg-card px-2 py-1 text-[12px] font-normal normal-case text-foreground outline-none focus:border-primary"
              />
            </label>
          ))}
          <button type="submit" className="col-span-2 rounded-md bg-primary py-1.5 text-[12px] font-semibold text-primary-foreground">
            Search
          </button>
        </div>
      )}
    </form>
  );
}
