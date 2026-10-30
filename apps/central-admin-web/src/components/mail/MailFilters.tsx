"use client";

// Mailbox filters (rules): create, edit, enable/disable, reorder, delete.
// The server validates every rule; this form only offers the safe, fixed
// operators the API accepts (no expressions, no scripts).

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import PermissionBoundary from "@/components/mail/PermissionBoundary";
import { useLabels } from "@/components/mail/hooks";
import { classifyMailError, createRule, deleteRule, fetchRules, reorderRules, updateRule } from "@/lib/mail.service";
import type { MailLabel, MailRule, MailRuleActions, MailRuleConditions, MailboxSummary } from "@/types/mail.types";

const card = "rounded-lg border border-border bg-card p-4";
const input = "w-full rounded-md border border-border bg-card px-3 py-2 text-[12px] outline-none focus:border-primary";
const btn = "rounded-md bg-primary px-3 py-1.5 text-[12px] font-semibold text-primary-foreground disabled:opacity-50";

export function describeRule(rule: Pick<MailRule, "conditions" | "actions">, labels: MailLabel[] = []): string {
  const c = rule.conditions;
  const when = [
    c.fromContains && `from contains "${c.fromContains}"`,
    c.fromEquals && `from is ${c.fromEquals}`,
    c.toContains && `to contains "${c.toContains}"`,
    c.subjectContains && `subject contains "${c.subjectContains}"`,
    typeof c.hasAttachment === "boolean" && (c.hasAttachment ? "has an attachment" : "has no attachment"),
  ].filter(Boolean);
  const a = rule.actions;
  const label = a.labelId ? labels.find((l) => l.id === a.labelId)?.name ?? "a label" : null;
  const then = [
    label && `label "${label}"`,
    a.folder && `move to ${a.folder.toLowerCase()}`,
    a.markRead && "mark read",
    a.star && "star",
    a.stopProcessing && "stop processing more filters",
  ].filter(Boolean);
  return `If ${when.join(" and ") || "anything"}, then ${then.join(", ") || "nothing"}.`;
}

const emptyConditions = { fromContains: "", toContains: "", subjectContains: "", hasAttachment: "any" as "any" | "yes" | "no" };

export default function MailFilters({ mailbox }: { mailbox: MailboxSummary }) {
  const qc = useQueryClient();
  const canManage = mailbox.type === "PERSONAL" ? mailbox.role === "OWNER" : mailbox.role === "OWNER" || mailbox.role === "MANAGER";
  const key = ["mail", "rules", mailbox.id];
  const rules = useQuery({ queryKey: key, queryFn: () => fetchRules(mailbox.id), enabled: canManage, retry: false, gcTime: 5 * 60 * 1000 });
  const labels = useLabels(mailbox.id);
  const [name, setName] = useState("");
  const [cond, setCond] = useState(emptyConditions);
  const [labelId, setLabelId] = useState("");
  const [folder, setFolder] = useState("");
  const [markRead, setMarkRead] = useState(false);
  const [star, setStar] = useState(false);
  const [stop, setStop] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: key });
  const onError = (e: unknown) => setMsg(classifyMailError(e).message);

  const conditions: MailRuleConditions = {
    ...(cond.fromContains.trim() ? { fromContains: cond.fromContains.trim() } : {}),
    ...(cond.toContains.trim() ? { toContains: cond.toContains.trim() } : {}),
    ...(cond.subjectContains.trim() ? { subjectContains: cond.subjectContains.trim() } : {}),
    ...(cond.hasAttachment !== "any" ? { hasAttachment: cond.hasAttachment === "yes" } : {}),
  };
  const actions: MailRuleActions = {
    ...(labelId ? { labelId } : {}),
    ...(folder ? { folder: folder as MailRuleActions["folder"] } : {}),
    ...(markRead ? { markRead: true as const } : {}),
    ...(star ? { star: true as const } : {}),
    ...(stop ? { stopProcessing: true as const } : {}),
  };
  const hasEffect = Boolean(labelId || folder || markRead || star);
  const valid = name.trim() && Object.keys(conditions).length > 0 && hasEffect;

  const create = useMutation({
    mutationFn: () => createRule(mailbox.id, { name: name.trim(), conditions, actions }),
    onSuccess: () => {
      setName(""); setCond(emptyConditions); setLabelId(""); setFolder(""); setMarkRead(false); setStar(false); setStop(false);
      setMsg("Filter created. It applies to new incoming mail.");
      refresh();
    },
    onError,
  });
  // Optimistic: the switch flips in the same event (no async gap, so the
  // controlled checkbox never snaps back) and rolls back on error.
  const [pendingEnabled, setPendingEnabled] = useState<Record<string, boolean>>({});
  const clearPending = (id: string) => setPendingEnabled(({ [id]: _done, ...rest }) => rest);
  const toggle = useMutation({
    mutationFn: ({ rule, enabled }: { rule: MailRule; enabled: boolean }) => updateRule(rule.id, { enabled }),
    onError: (e, { rule }) => { clearPending(rule.id); onError(e); },
    onSuccess: (_data, { rule, enabled }) => {
      qc.setQueryData<MailRule[]>(key, (current) => (current ?? []).map((r) => (r.id === rule.id ? { ...r, enabled } : r)));
      clearPending(rule.id);
    },
    onSettled: refresh,
  });
  const isEnabled = (rule: MailRule) => pendingEnabled[rule.id] ?? rule.enabled;
  const flip = (rule: MailRule) => {
    const enabled = !isEnabled(rule);
    setPendingEnabled((current) => ({ ...current, [rule.id]: enabled }));
    toggle.mutate({ rule, enabled });
  };
  const remove = useMutation({ mutationFn: (rule: MailRule) => deleteRule(rule.id), onSuccess: () => { setMsg("Filter deleted."); refresh(); }, onError });
  const move = useMutation({
    mutationFn: ({ index, delta }: { index: number; delta: number }) => {
      const ids = (rules.data ?? []).map((r) => r.id);
      const [moved] = ids.splice(index, 1);
      ids.splice(index + delta, 0, moved);
      return reorderRules(mailbox.id, ids);
    },
    onSuccess: refresh,
    onError,
  });

  return (
    <section className={card} aria-labelledby={`filters-h-${mailbox.id}`}>
      <h2 id={`filters-h-${mailbox.id}`} className="mb-1 text-[13px] font-semibold">Filters</h2>
      <p className="mb-2 text-[11px] text-muted-foreground">Filters run on new incoming mail, top to bottom. Quarantined mail is never moved out of Spam by a filter.</p>
      {!canManage ? (
        <p className="text-[12px] text-muted-foreground">Only the mailbox owner{mailbox.type === "SHARED" ? " or managers" : ""} can manage filters.</p>
      ) : (
        <PermissionBoundary isLoading={rules.isLoading} error={rules.error} compact>
          <ol className="mb-3 flex flex-col gap-1" aria-label="Filters in execution order">
            {(rules.data ?? []).length === 0 && <li className="text-[12px] text-muted-foreground">No filters yet.</li>}
            {(rules.data ?? []).map((rule, index, all) => (
              <li key={rule.id} className={`flex items-start gap-2 rounded border border-border px-2 py-1 text-[12px] ${isEnabled(rule) ? "" : "opacity-60"}`}>
                <div className="flex-1">
                  <p className="font-semibold">{rule.name}{isEnabled(rule) ? "" : " (off)"}</p>
                  <p className="text-[11px] text-muted-foreground">{describeRule(rule, labels.data ?? [])}</p>
                </div>
                <button type="button" aria-label={`Move ${rule.name} up`} className="rounded p-1 hover:bg-muted disabled:opacity-30" disabled={index === 0 || move.isPending} onClick={() => move.mutate({ index, delta: -1 })}><ArrowUp className="h-3.5 w-3.5" /></button>
                <button type="button" aria-label={`Move ${rule.name} down`} className="rounded p-1 hover:bg-muted disabled:opacity-30" disabled={index === all.length - 1 || move.isPending} onClick={() => move.mutate({ index, delta: 1 })}><ArrowDown className="h-3.5 w-3.5" /></button>
                <label className="flex items-center gap-1 text-[11px]">
                  <input type="checkbox" checked={isEnabled(rule)} disabled={rule.id in pendingEnabled} onChange={() => flip(rule)} aria-label={`${rule.name} enabled`} /> On
                </label>
                <button type="button" aria-label={`Delete ${rule.name}`} className="rounded p-1 text-red-600 hover:bg-muted" disabled={remove.isPending} onClick={() => window.confirm(`Delete filter "${rule.name}"?`) && remove.mutate(rule)}><Trash2 className="h-3.5 w-3.5" /></button>
              </li>
            ))}
          </ol>
          <form className="grid grid-cols-1 gap-2 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); if (valid) create.mutate(); }}>
            <label className="sm:col-span-2 text-[11px] text-muted-foreground">Filter name
              <input value={name} maxLength={160} onChange={(e) => setName(e.target.value)} className={input} placeholder="e.g. Supplier invoices" />
            </label>
            <fieldset className="sm:col-span-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <legend className="text-[11px] font-semibold text-muted-foreground">When a new email…</legend>
              <label className="text-[11px] text-muted-foreground">From contains
                <input value={cond.fromContains} maxLength={200} onChange={(e) => setCond({ ...cond, fromContains: e.target.value })} className={input} placeholder="name or address" />
              </label>
              <label className="text-[11px] text-muted-foreground">To contains
                <input value={cond.toContains} maxLength={200} onChange={(e) => setCond({ ...cond, toContains: e.target.value })} className={input} />
              </label>
              <label className="text-[11px] text-muted-foreground">Subject contains
                <input value={cond.subjectContains} maxLength={200} onChange={(e) => setCond({ ...cond, subjectContains: e.target.value })} className={input} />
              </label>
              <label className="text-[11px] text-muted-foreground">Attachment
                <select value={cond.hasAttachment} onChange={(e) => setCond({ ...cond, hasAttachment: e.target.value as "any" | "yes" | "no" })} className={input}>
                  <option value="any">Any</option><option value="yes">Has attachment</option><option value="no">No attachment</option>
                </select>
              </label>
            </fieldset>
            <fieldset className="sm:col-span-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <legend className="text-[11px] font-semibold text-muted-foreground">…then</legend>
              <label className="text-[11px] text-muted-foreground">Apply label
                <select value={labelId} onChange={(e) => setLabelId(e.target.value)} className={input}>
                  <option value="">No label</option>
                  {(labels.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </label>
              <label className="text-[11px] text-muted-foreground">Move to
                <select value={folder} onChange={(e) => setFolder(e.target.value)} className={input}>
                  <option value="">Keep in Inbox</option><option value="ARCHIVE">Archive</option><option value="SPAM">Spam</option><option value="TRASH">Trash</option>
                </select>
              </label>
              {mailbox.type === "PERSONAL" && (
                <>
                  <label className="flex items-center gap-2 text-[11px] text-muted-foreground"><input type="checkbox" checked={markRead} onChange={(e) => setMarkRead(e.target.checked)} /> Mark as read</label>
                  <label className="flex items-center gap-2 text-[11px] text-muted-foreground"><input type="checkbox" checked={star} onChange={(e) => setStar(e.target.checked)} /> Star it</label>
                </>
              )}
              <label className="flex items-center gap-2 text-[11px] text-muted-foreground"><input type="checkbox" checked={stop} onChange={(e) => setStop(e.target.checked)} /> Stop processing later filters</label>
            </fieldset>
            <button type="submit" className={`${btn} justify-self-start`} disabled={!valid || create.isPending}>Create filter</button>
            {!valid && name.trim() && <p className="sm:col-span-2 text-[11px] text-muted-foreground">Add at least one condition and one action.</p>}
          </form>
        </PermissionBoundary>
      )}
      {msg && <p role="status" className="mt-1 text-[11px] text-muted-foreground">{msg}</p>}
    </section>
  );
}
