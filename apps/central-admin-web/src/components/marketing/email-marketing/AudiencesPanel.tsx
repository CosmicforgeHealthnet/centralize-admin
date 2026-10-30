"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import PermissionBoundary from "@/components/mail/PermissionBoundary";
import { classifyMailError } from "@/lib/mail.service";
import {
  addAudienceContacts,
  createAudience,
  createSegment,
  fetchAudiences,
  fetchContacts,
  fetchSegments,
  previewSegment,
} from "@/lib/mail-marketing.service";
import type { Audience, MarketingOrganization, SegmentPreview, SegmentRule } from "@/types/mail-marketing.types";
import { EmCard, EmField, EmMessage, emBtn, emBtnOutline, emInput } from "./em-ui";

const FIELDS = [
  { id: "email", label: "Email" },
  { id: "email_domain", label: "Email domain" },
  { id: "first_name", label: "First name" },
  { id: "last_name", label: "Last name" },
  { id: "created_at", label: "Created at" },
  { id: "attributes.city", label: "Attribute: city" },
  { id: "attributes.country", label: "Attribute: country" },
];
const OPS = [
  { id: "equals", label: "equals" },
  { id: "not_equals", label: "does not equal" },
  { id: "contains", label: "contains" },
  { id: "ends_with", label: "ends with" },
  { id: "in", label: "is one of (comma separated)" },
  { id: "before", label: "before (date)" },
  { id: "after", label: "after (date)" },
  { id: "exists", label: "exists" },
];

function ruleValue(r: SegmentRule): unknown {
  if (r.op === "exists") return true;
  if (r.op === "in") return String(r.value ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  return r.value;
}

function SegmentBuilder({ org, audience }: { org: MarketingOrganization; audience: Audience }) {
  const qc = useQueryClient();
  const key = ["mail", "marketing", org.id, "segments", audience.id];
  const segments = useQuery({ queryKey: key, queryFn: () => fetchSegments(org.id, audience.id), gcTime: 300000, retry: false });
  const [name, setName] = useState("");
  const [match, setMatch] = useState<"all" | "any">("all");
  const [rules, setRules] = useState<SegmentRule[]>([{ field: "email_domain", op: "equals", value: "" }]);
  const [previews, setPreviews] = useState<Record<string, SegmentPreview | string>>({});
  const [msg, setMsg] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => createSegment(org.id, audience.id, { name: name.trim(), definition: { match, rules: rules.filter((r) => r.op === "exists" || String(r.value).trim()).map((r) => ({ ...r, value: ruleValue(r) })) } }),
    onSuccess: () => {
      setName("");
      setMsg("Segment saved.");
      qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => setMsg(classifyMailError(e).message),
  });

  const preview = async (segmentId: string) => {
    try {
      const p = await previewSegment(org.id, segmentId);
      setPreviews((s) => ({ ...s, [segmentId]: p }));
    } catch (e) {
      setPreviews((s) => ({ ...s, [segmentId]: classifyMailError(e).message }));
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <PermissionBoundary isLoading={segments.isLoading} error={segments.error} compact>
        <ul className="flex flex-col gap-1 text-[12px]">
          {(segments.data ?? []).length === 0 && <li className="text-muted-foreground">No segments. Campaigns can target the whole audience.</li>}
          {(segments.data ?? []).map((s) => {
            const p = previews[s.id];
            return (
              <li key={s.id} className="flex flex-wrap items-center gap-2 border-t border-border py-1">
                <span className="font-semibold">{s.name}</span>
                <span className="text-muted-foreground">
                  {s.definition.match ?? "all"} of {(s.definition.rules ?? []).map((r) => `${r.field} ${r.op} ${String(r.value)}`).join("; ")}
                </span>
                <button type="button" className="ml-auto text-primary hover:underline" onClick={() => preview(s.id)}>Preview</button>
                {p && (
                  <span className="w-full text-muted-foreground" role="status">
                    {typeof p === "string" ? p : `${p.total} matched · ${p.eligibleCount} eligible · ${p.excludedCount} excluded (consent/suppression/frequency)`}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </PermissionBoundary>
      {org.canAuthor && (
        <form
          className="flex flex-col gap-2 rounded-md border border-border p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
          aria-label="New segment"
        >
          <div className="flex flex-wrap gap-2">
            <EmField label="Segment name"><input value={name} onChange={(e) => setName(e.target.value)} className={emInput} required /></EmField>
            <EmField label="Match">
              <select value={match} onChange={(e) => setMatch(e.target.value as "all" | "any")} className={emInput}>
                <option value="all">All rules</option><option value="any">Any rule</option>
              </select>
            </EmField>
          </div>
          {rules.map((r, i) => (
            <div key={i} className="flex flex-wrap items-end gap-2">
              <label className="sr-only" htmlFor={`rule-f-${i}`}>Field</label>
              <select id={`rule-f-${i}`} value={r.field} onChange={(e) => setRules((rs) => rs.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)))} className={`${emInput} w-auto`}>
                {FIELDS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
              </select>
              <label className="sr-only" htmlFor={`rule-o-${i}`}>Operator</label>
              <select id={`rule-o-${i}`} value={r.op} onChange={(e) => setRules((rs) => rs.map((x, j) => (j === i ? { ...x, op: e.target.value } : x)))} className={`${emInput} w-auto`}>
                {OPS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
              <label className="sr-only" htmlFor={`rule-v-${i}`}>Value</label>
              <input id={`rule-v-${i}`} disabled={r.op === "exists"} type={r.op === "before" || r.op === "after" ? "date" : "text"} value={String(r.value ?? "")} onChange={(e) => setRules((rs) => rs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} className={`${emInput} w-48`} />
              <button type="button" aria-label="Remove rule" className={emBtnOutline} onClick={() => setRules((rs) => rs.filter((_, j) => j !== i))} disabled={rules.length === 1}>
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          <div className="flex gap-2">
            <button type="button" className={emBtnOutline} onClick={() => setRules((rs) => [...rs, { field: "email", op: "contains", value: "" }])}>
              <Plus className="h-3.5 w-3.5" /> Add rule
            </button>
            <button type="submit" className={emBtn} disabled={!name.trim() || create.isPending}>Save segment</button>
          </div>
          <EmMessage message={msg} />
        </form>
      )}
    </div>
  );
}

function AddMembers({ org, audience }: { org: MarketingOrganization; audience: Audience }) {
  const qc = useQueryClient();
  const contacts = useQuery({ queryKey: ["mail", "marketing", org.id, "contacts", ""], queryFn: () => fetchContacts(org.id), gcTime: 300000, retry: false });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: () => addAudienceContacts(org.id, audience.id, [...selected]),
    onSuccess: (r) => {
      setSelected(new Set());
      const rejected = Array.isArray(r.rejected) ? r.rejected.length : r.rejected ?? 0;
      setMsg(`${r.added} added${rejected ? `, ${rejected} rejected (no ${audience.topic} consent or suppressed)` : ""}.`);
      qc.invalidateQueries({ queryKey: ["mail", "marketing", org.id, "audiences"] });
    },
    onError: (e) => setMsg(classifyMailError(e).message),
  });
  return (
    <div className="flex flex-col gap-2 text-[12px]">
      <p className="text-muted-foreground">Only contacts with granted <strong>{audience.topic}</strong> consent are accepted by the server.</p>
      <PermissionBoundary isLoading={contacts.isLoading} error={contacts.error} compact>
        <ul className="max-h-48 overflow-auto rounded-md border border-border">
          {(contacts.data?.items ?? []).length === 0 && <li className="p-2 text-muted-foreground">No contacts.</li>}
          {(contacts.data?.items ?? []).map((c) => (
            <li key={c.id} className="border-b border-border px-2 py-1 last:border-0">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={selected.has(c.id)}
                  onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(c.id); else n.delete(c.id); return n; })}
                />
                {c.email}
                <span className="text-muted-foreground">{c.consents.find((k) => k.topic === audience.topic)?.status ?? "no consent"}</span>
              </label>
            </li>
          ))}
        </ul>
      </PermissionBoundary>
      <div className="flex items-center gap-2">
        <button type="button" className={emBtn} disabled={!selected.size || add.isPending} onClick={() => add.mutate()}>Add {selected.size || ""} to audience</button>
        <EmMessage message={msg} />
      </div>
    </div>
  );
}

export default function AudiencesPanel({ org }: { org: MarketingOrganization }) {
  const qc = useQueryClient();
  const key = ["mail", "marketing", org.id, "audiences"];
  const q = useQuery({ queryKey: key, queryFn: () => fetchAudiences(org.id), gcTime: 300000, retry: false });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("newsletter");
  const [description, setDescription] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => createAudience(org.id, { name: name.trim(), topic: topic.trim(), description: description.trim() || undefined }),
    onSuccess: (a) => {
      setName("");
      setDescription("");
      setSelectedId(a.id);
      qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => setMsg(classifyMailError(e).message),
  });
  const audiences = q.data?.items ?? [];
  const selected = audiences.find((a) => a.id === selectedId) ?? audiences[0];

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr]">
      <EmCard title="Audiences" id="em-audiences">
        <PermissionBoundary isLoading={q.isLoading} error={q.error} retry={() => q.refetch()} compact>
          <ul className="flex flex-col gap-1" role="listbox" aria-label="Audiences">
            {audiences.length === 0 && <li className="text-[12px] text-muted-foreground">No audiences.</li>}
            {audiences.map((a) => (
              <li key={a.id} role="option" aria-selected={selected?.id === a.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(a.id)}
                  className={`w-full rounded-md px-2 py-1.5 text-left text-[12px] ${selected?.id === a.id ? "bg-primary/10 font-semibold" : "hover:bg-muted"}`}
                >
                  {a.name}
                  <span className="block text-[10px] font-normal text-muted-foreground">
                    topic {a.topic}{a.contactCount != null ? ` · ${a.contactCount} contacts` : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </PermissionBoundary>
        {org.canAuthor && (
          <form className="mt-3 flex flex-col gap-2 border-t border-border pt-3" onSubmit={(e) => { e.preventDefault(); if (name.trim() && topic.trim()) create.mutate(); }}>
            <EmField label="New audience name"><input value={name} onChange={(e) => setName(e.target.value)} className={emInput} required /></EmField>
            <EmField label="Consent topic"><input value={topic} onChange={(e) => setTopic(e.target.value)} className={emInput} required /></EmField>
            <EmField label="Description"><input value={description} onChange={(e) => setDescription(e.target.value)} className={emInput} /></EmField>
            <button type="submit" className={emBtn} disabled={create.isPending}>Create audience</button>
            <EmMessage message={msg} tone="error" />
          </form>
        )}
      </EmCard>
      {selected ? (
        <div className="flex flex-col gap-4">
          <EmCard title={`${selected.name} — segments`} id="em-segments">
            {selected.description && <p className="mb-2 text-[12px] text-muted-foreground">{selected.description}</p>}
            <SegmentBuilder key={selected.id} org={org} audience={selected} />
          </EmCard>
          {org.canAuthor && (
            <EmCard title="Add contacts" id="em-add-members">
              <AddMembers key={selected.id} org={org} audience={selected} />
            </EmCard>
          )}
        </div>
      ) : null}
    </div>
  );
}
