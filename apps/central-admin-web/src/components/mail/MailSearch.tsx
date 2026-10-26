"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Search, SlidersHorizontal, X } from "lucide-react";
import { isTypingTarget } from "./mail-utils";
import { mailKeys } from "./hooks";
import { fetchLabels } from "@/lib/mail.service";

const ADVANCED = ["from", "to", "subject", "after", "before"] as const;
// Neutral wording: whether message bodies are searchable depends on the
// server's body-search setting, which is not reported to every user.
const SCOPE_HINT = "Searches subject, sender and recipients, and message text where body search is enabled.";

export default function MailSearch() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const route = useParams<{ mailboxId?: string }>();
  const mailboxId = typeof route?.mailboxId === "string" ? route.mailboxId : null;
  const labels = useQuery({
    queryKey: mailKeys.labels(mailboxId ?? ""),
    queryFn: () => fetchLabels(mailboxId as string),
    enabled: Boolean(mailboxId),
  });
  const inputRef = useRef<HTMLInputElement>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const currentQuery = params.toString();

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
    const form = e?.currentTarget as HTMLFormElement | undefined;
    const values = form ? new FormData(form) : new FormData();
    const next = new URLSearchParams();
    const q = String(values.get("q") ?? "").trim();
    if (q) next.set("q", q);
    for (const k of ADVANCED) {
      const value = String(values.get(k) ?? "").trim();
      if (value) next.set(k, value);
    }
    const labelId = String(values.get("labelId") ?? "");
    if (labelId) next.set("labelId", labelId);
    // Results are always mailbox scoped by the server; leave thread view.
    const listPath = pathname.split("/thread/")[0];
    router.push(next.toString() ? `${listPath}?${next.toString()}` : listPath);
  };

  const clear = () => {
    router.push(pathname.split("/thread/")[0]);
  };

  return (
    <div className="flex flex-col gap-2">
    <form key={currentQuery} role="search" aria-label="Search this mailbox" onSubmit={submit} className="flex flex-col gap-2">
      <div className="flex min-h-10 items-center gap-2 rounded-lg border border-border bg-background px-3 transition-colors focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/15">
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <label htmlFor="mail-search" className="sr-only">Search mail</label>
        <span id="mail-search-scope" className="sr-only">{SCOPE_HINT}</span>
        <input
          id="mail-search"
          ref={inputRef}
          name="q"
          defaultValue={params.get("q") ?? ""}
          placeholder="Search this mailbox…"
          title={SCOPE_HINT}
          aria-describedby="mail-search-scope"
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        {params.get("q") && (
          <button type="button" onClick={clear} aria-label="Clear search" className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary">
            <X className="h-4 w-4" />
          </button>
        )}
        <button
          type="button"
          onClick={() => setShowAdvanced((s) => !s)}
          aria-expanded={showAdvanced}
          aria-controls="mail-search-advanced"
          aria-label="Advanced search"
          className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
        >
          <SlidersHorizontal className="h-4 w-4" />
        </button>
      </div>
      {showAdvanced && (
        <div id="mail-search-advanced" className="grid grid-cols-2 gap-3 rounded-lg border border-border bg-card p-3 shadow-sm">
          {ADVANCED.map((k) => (
            <label key={k} className="flex flex-col gap-0.5 text-[10px] font-semibold uppercase text-muted-foreground">
              {k}
              <input
                type={k === "after" || k === "before" ? "date" : "text"}
                name={k}
                defaultValue={params.get(k) ?? ""}
                className="min-h-10 rounded-md border border-border bg-background px-3 py-2 text-sm font-normal normal-case text-foreground outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20"
              />
            </label>
          ))}
          {mailboxId && (
            <label className="col-span-2 flex flex-col gap-0.5 text-[10px] font-semibold uppercase text-muted-foreground">
              label
              <select
                name="labelId"
                defaultValue={params.get("labelId") ?? ""}
              className="min-h-10 rounded-md border border-border bg-background px-3 py-2 text-sm font-normal normal-case text-foreground outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20"
              >
                <option value="">Any label</option>
                {(labels.data ?? []).map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button type="submit" className="col-span-2 min-h-10 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
            Search
          </button>
        </div>
      )}
    </form>
    {ADVANCED.some((key) => params.get(key)) || params.get("q") ? (
      <div className="flex flex-wrap items-center gap-1.5" aria-label="Active search filters">
        {(["q", ...ADVANCED] as const).filter((key) => params.get(key)).map((key) => (
          <span key={key} className="inline-flex min-w-0 items-center gap-1 rounded-full bg-primary/10 py-1 pl-2.5 pr-1 text-xs text-foreground">
            <span className="shrink-0 font-medium">{key === "q" ? "Search" : key === "after" ? "After" : key === "before" ? "Before" : `${key[0].toUpperCase()}${key.slice(1)}`}:</span>
            <span className="max-w-40 truncate">{params.get(key)}</span>
            <button
              type="button"
              aria-label={`Remove ${key} filter`}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full hover:bg-primary/15 focus-visible:outline-2 focus-visible:outline-primary"
              onClick={() => {
                const next = new URLSearchParams(currentQuery);
                next.delete(key);
                const listPath = pathname.split("/thread/")[0];
                router.push(next.toString() ? `${listPath}?${next.toString()}` : listPath);
              }}
            ><X className="h-3 w-3" aria-hidden="true" /></button>
          </span>
        ))}
        <button type="button" onClick={clear} className="min-h-7 rounded-md px-2 text-xs font-medium text-primary hover:bg-primary/10 focus-visible:outline-2 focus-visible:outline-primary">Clear all</button>
      </div>
    ) : null}
    </div>
  );
}
