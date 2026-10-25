"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import PermissionBoundary from "@/components/mail/PermissionBoundary";
import { formatFullDate } from "@/components/mail/mail-utils";
import { classifyMailError } from "@/lib/mail.service";
import { createCampaign, fetchCampaigns } from "@/lib/mail-marketing.service";
import type { MarketingOrganization } from "@/types/mail-marketing.types";
import { EmBadge, EmCard, EmField, EmMessage, emBtn, emBtnOutline, emInput } from "./em-ui";

const STATUSES = ["", "DRAFT", "READY_FOR_REVIEW", "APPROVED", "REJECTED"];

export default function CampaignList({ org }: { org: MarketingOrganization }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [status, setStatus] = useState("");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("newsletter");
  const [msg, setMsg] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["mail", "marketing", org.id, "campaigns", status],
    queryFn: () => fetchCampaigns(org.id, status ? { status } : {}),
    gcTime: 300000,
    retry: false,
  });
  const create = useMutation({
    mutationFn: () => createCampaign(org.id, { name: name.trim(), topic: topic.trim() }),
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: ["mail", "marketing", org.id, "campaigns"] });
      router.push(`/dashboard/marketing/email-marketing/campaigns/${c.id}?org=${org.id}`);
    },
    onError: (e) => setMsg(classifyMailError(e).message),
  });

  return (
    <EmCard
      title="Email campaigns"
      id="em-campaigns"
      actions={
        <>
          <label className="flex items-center gap-1 text-[12px] text-muted-foreground">
            <span className="sr-only">Filter by status</span>
            <select value={status} onChange={(e) => setStatus(e.target.value)} className="rounded-md border border-border bg-card px-2 py-1 text-[12px]">
              {STATUSES.map((s) => (
                <option key={s} value={s}>{s ? s.replace(/_/g, " ") : "All statuses"}</option>
              ))}
            </select>
          </label>
          {org.canAuthor && (
            <button type="button" className={emBtn} onClick={() => setCreating((c) => !c)} aria-expanded={creating}>
              <Plus className="h-3.5 w-3.5" /> New campaign
            </button>
          )}
        </>
      }
    >
      {creating && (
        <form
          className="mb-4 grid grid-cols-1 gap-2 rounded-md border border-border p-3 sm:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim() && topic.trim()) create.mutate();
          }}
        >
          <EmField label="Campaign name">
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} className={emInput} required />
          </EmField>
          <EmField label="Consent topic" hint="Only contacts consenting to this topic are eligible.">
            <input value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={64} className={emInput} required />
          </EmField>
          <div className="flex items-end gap-2">
            <button type="submit" className={emBtn} disabled={create.isPending}>Create draft</button>
            <button type="button" className={emBtnOutline} onClick={() => setCreating(false)}>Cancel</button>
          </div>
          <div className="sm:col-span-3"><EmMessage message={msg} tone="error" /></div>
        </form>
      )}
      <PermissionBoundary isLoading={q.isLoading} error={q.error} retry={() => q.refetch()}>
        {(q.data?.items ?? []).length === 0 ? (
          <p role="status" className="p-4 text-center text-[12px] text-muted-foreground">No campaigns.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[12px]">
              <thead className="text-muted-foreground">
                <tr><th className="py-1.5">Name</th><th>Status</th><th>Topic</th><th>Revision</th><th>Updated</th></tr>
              </thead>
              <tbody>
                {(q.data?.items ?? []).map((c) => (
                  <tr key={c.id} className="border-t border-border">
                    <td className="py-1.5">
                      <Link href={`/dashboard/marketing/email-marketing/campaigns/${c.id}?org=${org.id}`} className="font-semibold text-primary hover:underline">
                        {c.name}
                      </Link>
                    </td>
                    <td><EmBadge value={c.status} /></td>
                    <td>{c.topic}</td>
                    <td>{c.revision}</td>
                    <td className="text-muted-foreground">{formatFullDate(c.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </PermissionBoundary>
    </EmCard>
  );
}
