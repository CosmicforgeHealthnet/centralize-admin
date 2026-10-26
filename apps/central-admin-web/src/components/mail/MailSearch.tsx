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
  const [q, setQ] = useState(params.get("q") ?? "");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [advanced, setAdvanced] = useState<Record<string, string>>(() =>
    Object.fromEntries(ADVANCED.map((k) => [k, params.get(k) ?? ""])),
  );
  const [labelId, setLabelId] = useState(params.get("labelId") ?? "");

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
    if (labelId) next.set("labelId", labelId);
    // Results are always mailbox scoped by the server; leave thread view.
    const listPath = pathname.split("/thread/")[0];
    router.push(next.toString() ? `${listPath}?${next.toString()}` : listPath);
  };

  const clear = () => {
    setQ("");
    setAdvanced(Object.fromEntries(ADVANCED.map((k) => [k, ""])));
    setLabelId("");
    router.push(pathname.split("/thread/")[0]);
  };

  return (
    <form role="search" onSubmit={submit} className="flex flex-col gap-2">
      <div className="flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1.5 focus-within:border-primary">
        <Search className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <label htmlFor="mail-search" className="sr-only">Search mail</label>
        <span id="mail-search-scope" className="sr-only">{SCOPE_HINT}</span>
        <input
          id="mail-search"
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search subject, sender, recipients ( / )"
          title={SCOPE_HINT}
          aria-describedby="mail-search-scope"
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
          {mailboxId && (
            <label className="col-span-2 flex flex-col gap-0.5 text-[10px] font-semibold uppercase text-muted-foreground">
              label
              <select
                value={labelId}
                onChange={(e) => setLabelId(e.target.value)}
                className="rounded border border-border bg-card px-2 py-1 text-[12px] font-normal normal-case text-foreground outline-none focus:border-primary"
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
          <button type="submit" className="col-span-2 rounded-md bg-primary py-1.5 text-[12px] font-semibold text-primary-foreground">
            Search
          </button>
        </div>
      )}
    </form>
  );
}
