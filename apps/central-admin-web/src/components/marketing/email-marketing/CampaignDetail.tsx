"use client";

import { useMemo, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Lock, XCircle } from "lucide-react";
import PermissionBoundary from "@/components/mail/PermissionBoundary";
import { formatFullDate } from "@/components/mail/mail-utils";
import { classifyMailError } from "@/lib/mail.service";
import {
  approveCampaign,
  fetchAudiences,
  fetchCampaign,
  fetchCampaignHistory,
  fetchSegments,
  fetchSenderIdentities,
  fetchTemplate,
  fetchTemplates,
  preflightCampaign,
  rejectCampaign,
  submitCampaign,
  updateCampaign,
} from "@/lib/mail-marketing.service";
import { useAuthStore } from "@/stores/auth.store";
import type { Campaign, CampaignInput, MarketingOrganization, PreflightResult } from "@/types/mail-marketing.types";
import StepUpDialog from "./StepUpDialog";
import { EmBadge, EmCard, EmField, EmMessage, emBtn, emBtnOutline, emInput } from "./em-ui";

const EDITABLE: Campaign["status"][] = ["DRAFT", "REJECTED", "READY_FOR_REVIEW", "APPROVED"];

export default function CampaignDetail({ org, campaignId }: { org: MarketingOrganization; campaignId: string }) {
  const qc = useQueryClient();
  const me = useAuthStore((s) => s.user);
  const key = ["mail", "marketing", org.id, "campaign", campaignId];
  const campaignQ = useQuery({ queryKey: key, queryFn: () => fetchCampaign(org.id, campaignId), gcTime: 300000, retry: false });
  const historyQ = useQuery({ queryKey: [...key, "history"], queryFn: () => fetchCampaignHistory(org.id, campaignId), gcTime: 300000, retry: false });
  const audiencesQ = useQuery({ queryKey: ["mail", "marketing", org.id, "audiences"], queryFn: () => fetchAudiences(org.id), gcTime: 300000, retry: false });
  const templatesQ = useQuery({ queryKey: ["mail", "marketing", org.id, "templates"], queryFn: () => fetchTemplates(org.id), gcTime: 300000, retry: false });
  const sendersQ = useQuery({
    queryKey: ["mail", "marketing", org.id, "sender-identities"],
    queryFn: () => fetchSenderIdentities(org.id),
    gcTime: 300000,
    retry: false,
  });
  const senderOptions = sendersQ.data ?? [];

  const [form, setForm] = useState<CampaignInput>({});
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState<{ text: string; tone: "info" | "error" } | null>(null);
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [approveComment, setApproveComment] = useState("");
  const [rejectComment, setRejectComment] = useState("");

  const campaign = campaignQ.data;
  const [formFor, setFormFor] = useState<string | null>(null);
  // Re-seed the form whenever a new campaign revision is loaded (derived state).
  if (campaign && formFor !== `${campaign.id}:${campaign.revision}:${campaign.updatedAt}`) {
    setFormFor(`${campaign.id}:${campaign.revision}:${campaign.updatedAt}`);
    setForm({
      name: campaign.name,
      topic: campaign.topic,
      senderAddressId: campaign.senderAddressId,
      replyTo: campaign.replyTo,
      subjectOverride: campaign.subjectOverride,
      templateVersionId: campaign.templateVersionId,
      audienceId: campaign.audienceId,
      segmentId: campaign.segmentId,
      frequencyCapHours: campaign.frequencyCapHours,
      legacyCampaignId: campaign.legacyCampaignId,
    });
    setDirty(false);
  }

  const segmentsQ = useQuery({
    queryKey: ["mail", "marketing", org.id, "segments", form.audienceId ?? ""],
    queryFn: () => fetchSegments(org.id, form.audienceId as string),
    enabled: !!form.audienceId,
    gcTime: 300000,
    retry: false,
  });
  const templateDetails = useQueries({
    queries: (templatesQ.data?.items ?? []).map((t) => ({
      queryKey: ["mail", "marketing", org.id, "template", t.id],
      queryFn: () => fetchTemplate(org.id, t.id),
      gcTime: 300000,
      retry: false,
    })),
  });
  const versionOptions = useMemo(
    () =>
      templateDetails.flatMap((q) =>
        (q.data?.versions ?? []).map((v) => ({ id: v.id, label: `${q.data?.name} · v${v.version} · ${v.subject}` })),
      ),
    [templateDetails],
  );

  const refresh = () => {
    qc.invalidateQueries({ queryKey: key });
    qc.invalidateQueries({ queryKey: ["mail", "marketing", org.id, "campaigns"] });
  };
  const onErr = (e: unknown) => {
    const info = classifyMailError(e);
    if (info.kind === "conflict" && info.code !== "MAIL_INVALID_TRANSITION") {
      setMsg({ text: "This campaign was changed by someone else. Reloaded the latest revision; re-apply your edits.", tone: "error" });
      refresh();
    } else setMsg({ text: info.message, tone: "error" });
  };

  const save = useMutation({
    mutationFn: () => updateCampaign(org.id, campaignId, { ...form, revision: campaign?.revision ?? 1 }),
    onSuccess: (c) => {
      setMsg({
        text:
          campaign && (campaign.status === "APPROVED" || campaign.status === "READY_FOR_REVIEW") && c.status === "DRAFT"
            ? "Saved. The material change invalidated the previous review; the campaign is back in draft."
            : "Saved.",
        tone: "info",
      });
      setPreflight(null);
      refresh();
    },
    onError: onErr,
  });
  const runPreflight = useMutation({ mutationFn: () => preflightCampaign(org.id, campaignId), onSuccess: setPreflight, onError: onErr });
  const submit = useMutation({
    mutationFn: () => submitCampaign(org.id, campaignId, campaign?.revision ?? 1),
    onSuccess: () => {
      setMsg({ text: "Submitted for review. Content is now snapshotted.", tone: "info" });
      refresh();
    },
    onError: onErr,
  });
  const approve = useMutation({
    mutationFn: (stepUpId: string) =>
      approveCampaign(org.id, campaignId, { revision: campaign?.revision ?? 1, stepUpId, comment: approveComment || undefined }),
    onSuccess: () => {
      setStepUpOpen(false);
      setMsg({ text: "Campaign approved. Dispatch is not enabled in this release (M7).", tone: "info" });
      refresh();
    },
    onError: (e) => {
      setStepUpOpen(false);
      onErr(e);
    },
  });
  const reject = useMutation({
    mutationFn: () => rejectCampaign(org.id, campaignId, { revision: campaign?.revision ?? 1, comment: rejectComment.trim() }),
    onSuccess: () => {
      setRejectComment("");
      setMsg({ text: "Campaign rejected and returned to the author.", tone: "info" });
      refresh();
    },
    onError: onErr,
  });

  const set = <K extends keyof CampaignInput>(k: K, v: CampaignInput[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setDirty(true);
  };

  if (!campaign) {
    return (
      <EmCard>
        <PermissionBoundary isLoading={campaignQ.isLoading} error={campaignQ.error} retry={() => campaignQ.refetch()}>
          {null}
        </PermissionBoundary>
      </EmCard>
    );
  }

  const canEdit = org.canAuthor && EDITABLE.includes(campaign.status);
  const isAuthor = me?.id === campaign.createdByAdminUserId;
  const canReview = org.canApprove && campaign.status === "READY_FOR_REVIEW";

  return (
    <div className="flex flex-col gap-4">
      <EmCard
        title={campaign.name}
        id="cd-title"
        actions={
          <>
            <EmBadge value={campaign.status} />
            <span className="text-[11px] text-muted-foreground">Revision {campaign.revision}</span>
          </>
        }
      >
        {campaign.status === "APPROVED" && (
          <p role="status" className="mb-3 flex items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-[12px] text-muted-foreground">
            <Lock className="h-4 w-4" aria-hidden="true" /> Dispatch not enabled (M7). Approved content is immutable; editing returns the campaign to draft.
          </p>
        )}
        <form
          className="grid grid-cols-1 gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            setMsg(null);
            save.mutate();
          }}
        >
          <EmField label="Name">
            <input value={form.name ?? ""} disabled={!canEdit} onChange={(e) => set("name", e.target.value)} className={emInput} />
          </EmField>
          <EmField label="Consent topic">
            <input value={form.topic ?? ""} disabled={!canEdit} onChange={(e) => set("topic", e.target.value)} className={emInput} />
          </EmField>
          <EmField
            label="Sender identity"
            hint={
              sendersQ.isError
                ? classifyMailError(sendersQ.error).message
                : !sendersQ.isLoading && senderOptions.length === 0
                  ? "No approved marketing sender identity is available to you for this brand."
                  : undefined
            }
          >
            <select value={form.senderAddressId ?? ""} disabled={!canEdit} onChange={(e) => set("senderAddressId", e.target.value || null)} className={emInput}>
              <option value="">Select approved sender</option>
              {senderOptions.map((s) => (
                <option key={s.addressId} value={s.addressId}>
                  {s.displayName ? `${s.displayName} <${s.address}>` : s.address}
                  {s.mailboxName ? ` · ${s.mailboxName}` : ""}
                  {s.domainVerifiedForSending ? "" : " · domain not verified"}
                </option>
              ))}
              {form.senderAddressId && !senderOptions.some((s) => s.addressId === form.senderAddressId) && (
                <option value={form.senderAddressId}>{campaign.senderAddress ?? form.senderAddressId}</option>
              )}
            </select>
            {(() => {
              const chosen = senderOptions.find((x) => x.addressId === form.senderAddressId);
              return chosen && !chosen.domainVerifiedForSending ? (
                <span role="status" className="mt-1 inline-flex w-fit rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
                  Sending domain not verified — preflight will fail
                </span>
              ) : null;
            })()}
          </EmField>
          <EmField label="Reply-To">
            <input type="email" value={form.replyTo ?? ""} disabled={!canEdit} onChange={(e) => set("replyTo", e.target.value || null)} className={emInput} />
          </EmField>
          <EmField label="Template version" hint="Approval locks the exact version.">
            <select value={form.templateVersionId ?? ""} disabled={!canEdit} onChange={(e) => set("templateVersionId", e.target.value || null)} className={emInput}>
              <option value="">Select a template version</option>
              {versionOptions.map((v) => (
                <option key={v.id} value={v.id}>{v.label}</option>
              ))}
            </select>
          </EmField>
          <EmField label="Subject override (optional)">
            <input value={form.subjectOverride ?? ""} disabled={!canEdit} onChange={(e) => set("subjectOverride", e.target.value || null)} className={emInput} />
          </EmField>
          <EmField label="Audience">
            <select
              value={form.audienceId ?? ""}
              disabled={!canEdit}
              onChange={(e) => {
                set("audienceId", e.target.value || null);
                set("segmentId", null);
              }}
              className={emInput}
            >
              <option value="">Select audience</option>
              {(audiencesQ.data?.items ?? []).map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </EmField>
          <EmField label="Segment (optional)">
            <select value={form.segmentId ?? ""} disabled={!canEdit || !form.audienceId} onChange={(e) => set("segmentId", e.target.value || null)} className={emInput}>
              <option value="">Whole audience</option>
              {(segmentsQ.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </EmField>
          <EmField label="Frequency cap (hours)" hint="Contacts emailed by this brand within this window are excluded.">
            <input type="number" min={0} max={8760} value={form.frequencyCapHours ?? 72} disabled={!canEdit} onChange={(e) => set("frequencyCapHours", Number(e.target.value))} className={emInput} />
          </EmField>
          <EmField label="Legacy campaign reference (optional)">
            <input value={form.legacyCampaignId ?? ""} disabled={!canEdit} onChange={(e) => set("legacyCampaignId", e.target.value || null)} className={emInput} />
          </EmField>
          {canEdit && (
            <div className="sm:col-span-2 flex flex-wrap items-center gap-2">
              <button type="submit" className={emBtn} disabled={!dirty || save.isPending}>{save.isPending ? "Saving…" : "Save changes"}</button>
              {(campaign.status === "APPROVED" || campaign.status === "READY_FOR_REVIEW") && dirty && (
                <span className="text-[11px] text-amber-700">Saving material changes will invalidate the current review.</span>
              )}
            </div>
          )}
        </form>
        {msg && <div className="mt-2"><EmMessage message={msg.text} tone={msg.tone} /></div>}
      </EmCard>

      <EmCard
        title="Preflight"
        id="cd-preflight"
        actions={
          <button type="button" className={emBtnOutline} onClick={() => runPreflight.mutate()} disabled={runPreflight.isPending}>
            {runPreflight.isPending ? "Checking…" : "Run preflight"}
          </button>
        }
      >
        {!preflight ? (
          <p className="text-[12px] text-muted-foreground">Run preflight to check sender, consent, suppression, frequency cap and content.</p>
        ) : (
          <>
            <p className={`mb-2 text-[12px] font-semibold ${preflight.ok ? "text-emerald-700" : "text-red-600"}`}>
              {preflight.ok ? "All checks passed." : "Some checks failed."} Eligible: {preflight.eligibleCount} · Excluded: {preflight.excludedCount}
            </p>
            <ul className="flex flex-col gap-1 text-[12px]">
              {preflight.checks.map((c) => (
                <li key={c.id} className="flex items-start gap-2">
                  {c.ok ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 text-emerald-600" aria-label="Passed" /> : <XCircle className="mt-0.5 h-3.5 w-3.5 text-red-600" aria-label="Failed" />}
                  <span><span className="font-semibold">{c.id}</span> — {c.detail}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </EmCard>

      <EmCard title="Review" id="cd-review">
        <div className="flex flex-col gap-3 text-[12px]">
          {org.canAuthor && (campaign.status === "DRAFT" || campaign.status === "REJECTED") && (
            <div className="flex items-center gap-2">
              <button type="button" className={emBtn} onClick={() => submit.mutate()} disabled={submit.isPending || dirty}>
                Submit for review
              </button>
              {dirty && <span className="text-muted-foreground">Save changes first.</span>}
            </div>
          )}
          {canReview && (
            isAuthor ? (
              <p className="text-muted-foreground">You authored this campaign; a different reviewer must approve it.</p>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <EmField label="Approval comment (optional)">
                    <textarea rows={2} value={approveComment} onChange={(e) => setApproveComment(e.target.value)} className={emInput} />
                  </EmField>
                  <button type="button" className={emBtn} onClick={() => setStepUpOpen(true)} disabled={approve.isPending}>
                    Approve (requires 2FA code)
                  </button>
                </div>
                <form
                  className="flex flex-col gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (rejectComment.trim()) reject.mutate();
                  }}
                >
                  <EmField label="Rejection reason">
                    <textarea rows={2} value={rejectComment} onChange={(e) => setRejectComment(e.target.value)} className={emInput} required />
                  </EmField>
                  <button type="submit" className={emBtnOutline} disabled={!rejectComment.trim() || reject.isPending}>Reject</button>
                </form>
              </div>
            )
          )}
          {!canReview && campaign.status === "READY_FOR_REVIEW" && !org.canApprove && (
            <p className="text-muted-foreground">Awaiting review by an authorized brand reviewer.</p>
          )}
        </div>
      </EmCard>

      <EmCard title="History" id="cd-history">
        <PermissionBoundary isLoading={historyQ.isLoading} error={historyQ.error} compact>
          <div className="grid grid-cols-1 gap-4 text-[12px] lg:grid-cols-2">
            <div>
              <h3 className="mb-1 font-semibold">Decisions</h3>
              <ul className="flex flex-col gap-1">
                {(historyQ.data?.approvals ?? []).length === 0 && <li className="text-muted-foreground">No decisions yet.</li>}
                {(historyQ.data?.approvals ?? []).map((a) => (
                  <li key={a.id}>
                    <EmBadge value={a.decision} /> r{a.revision} · {formatFullDate(a.createdAt)}
                    {a.comment ? ` · “${a.comment}”` : ""}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="mb-1 font-semibold">Immutable snapshots</h3>
              <ul className="flex flex-col gap-1">
                {(historyQ.data?.snapshots ?? []).length === 0 && <li className="text-muted-foreground">No snapshots yet.</li>}
                {(historyQ.data?.snapshots ?? []).map((s) => (
                  <li key={s.id}>
                    {s.kind} r{s.revision} · {s.eligibleCount} eligible / {s.excludedCount} excluded · {formatFullDate(s.createdAt)}
                    <span className="block font-mono text-[10px] text-muted-foreground">sha256 {s.contentSha256.slice(0, 16)}…</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="lg:col-span-2">
              <h3 className="mb-1 font-semibold">Audit trail</h3>
              <ul className="flex flex-col gap-0.5 text-muted-foreground">
                {(historyQ.data?.audit ?? []).length === 0 && <li>No audit events.</li>}
                {(historyQ.data?.audit ?? []).map((a) => (
                  <li key={a.id}>{formatFullDate(a.createdAt)} · {a.action}</li>
                ))}
              </ul>
            </div>
          </div>
        </PermissionBoundary>
      </EmCard>

      {stepUpOpen && (
        <StepUpDialog
          purpose="MARKETING_CAMPAIGN_APPROVAL"
          title="Confirm campaign approval"
          onCancel={() => setStepUpOpen(false)}
          onVerified={(id) => approve.mutateAsync(id).then(() => undefined)}
        />
      )}
    </div>
  );
}
