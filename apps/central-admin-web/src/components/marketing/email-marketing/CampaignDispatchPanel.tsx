"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, PauseCircle, PlayCircle, Send, XCircle } from "lucide-react";
import PermissionBoundary from "@/components/mail/PermissionBoundary";
import { formatFullDate } from "@/components/mail/mail-utils";
import { classifyMailError } from "@/lib/mail.service";
import {
  cancelDispatch,
  fetchBrandSettings,
  fetchBroadcastRecipients,
  fetchBroadcastReport,
  fetchDispatch,
  pauseDispatch,
  resumeDispatch,
  scheduleCampaign,
} from "@/lib/mail-marketing.service";
import type { Campaign, MarketingOrganization } from "@/types/mail-marketing.types";
import { BROADCAST_STATUS_HELP, EmBadge, EmCard, EmField, EmMessage, emBtn, emBtnOutline, emInput } from "./em-ui";

const ACTIVE = new Set(["SCHEDULED", "QUEUED", "PREPARING", "SENDING", "PAUSED"]);
const FALLBACK_ZONES = ["UTC", "Africa/Lagos", "Africa/Accra", "Africa/Nairobi", "Africa/Johannesburg", "Europe/London", "Europe/Berlin", "America/New_York", "America/Los_Angeles", "Asia/Dubai"];

function timeZones(): string[] {
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone");
    return supported && supported.length ? supported : FALLBACK_ZONES;
  } catch {
    return FALLBACK_ZONES;
  }
}

function scheduleErrorText(err: unknown): string {
  const info = classifyMailError(err);
  const reason = (info.detail as { reason?: unknown } | undefined)?.reason;
  if (reason === "SCHEDULE_TIME_NONEXISTENT") return "That local time does not exist in the selected time zone (daylight saving change). Pick another time.";
  if (reason === "TOO_SOON") return "The send time must be at least a few minutes from now so it can still be cancelled.";
  if (reason === "TOO_FAR_AHEAD") return "Broadcasts can be scheduled at most 60 days ahead.";
  if (info.code === "MAIL_APPROVAL_EXPIRED") return "The approval has expired. Edit and resubmit the campaign for review.";
  if (info.code === "MAIL_BROADCAST_DISABLED") return "Broadcast dispatch is not enabled in this environment.";
  if (info.code === "MAIL_EMERGENCY_STOP") return "Sending is stopped by an emergency stop.";
  return info.message;
}

export default function CampaignDispatchPanel({ org, campaign }: { org: MarketingOrganization; campaign: Campaign }) {
  const qc = useQueryClient();
  const key = ["mail", "marketing", org.id, "dispatch", campaign.id];
  const dispatchQ = useQuery({
    queryKey: key,
    queryFn: () => fetchDispatch(org.id, campaign.id),
    retry: false,
    refetchInterval: (query) => (query.state.data?.dispatch && ACTIVE.has(query.state.data.dispatch.status) ? 15000 : false),
  });
  const settingsQ = useQuery({ queryKey: ["mail", "marketing", org.id, "settings"], queryFn: () => fetchBrandSettings(org.id), retry: false, gcTime: 300000 });
  const dispatch = dispatchQ.data?.dispatch ?? null;
  const reportQ = useQuery({
    queryKey: [...key, "report"],
    queryFn: () => fetchBroadcastReport(org.id, campaign.id),
    enabled: !!dispatch && ["SENDING", "COMPLETED", "PARTIAL", "CANCELLED", "OUTCOME_UNKNOWN"].includes(dispatch.status),
    retry: false,
  });
  const [recipientFilter, setRecipientFilter] = useState("");
  const recipientsQ = useQuery({
    queryKey: [...key, "recipients", recipientFilter],
    queryFn: () => fetchBroadcastRecipients(org.id, campaign.id, { status: recipientFilter || undefined }),
    enabled: !!dispatch,
    retry: false,
  });

  const zone = settingsQ.data?.defaultTimeZone ?? "UTC";
  const [date, setDate] = useState("");
  const [time, setTime] = useState("09:00");
  const [tz, setTz] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; tone: "info" | "error" } | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const refresh = () => {
    qc.invalidateQueries({ queryKey: key });
    qc.invalidateQueries({ queryKey: ["mail", "marketing", org.id, "campaign", campaign.id] });
  };
  const onErr = (err: unknown) => setMsg({ text: scheduleErrorText(err), tone: "error" });

  const schedule = useMutation({
    mutationFn: () => scheduleCampaign(org.id, campaign.id, date ? { revision: campaign.revision, sendAt: `${date}T${time}`, timeZone: tz ?? zone } : { revision: campaign.revision }),
    onSuccess: (d) => {
      setMsg({ text: `Scheduled for ${formatFullDate(d.scheduledFor)}${d.ambiguousLocalTime ? " (that local time occurs twice; the first occurrence was used)" : ""}.`, tone: "info" });
      refresh();
    },
    onError: onErr,
  });
  const cancel = useMutation({
    mutationFn: () => cancelDispatch(org.id, campaign.id, cancelReason.trim() || undefined),
    onSuccess: (d) => {
      setConfirmCancel(false);
      setMsg({ text: d.note ?? "Cancellation recorded.", tone: "info" });
      refresh();
    },
    onError: onErr,
  });
  const pause = useMutation({ mutationFn: () => pauseDispatch(org.id, campaign.id), onSuccess: refresh, onError: onErr });
  const resume = useMutation({ mutationFn: () => resumeDispatch(org.id, campaign.id), onSuccess: refresh, onError: onErr });

  const canAct = org.canAuthor || org.canApprove;
  const dispatchEnabled = dispatchQ.data?.dispatchEnabled ?? campaign.dispatchEnabled ?? false;

  return (
    <EmCard title="Broadcast" id="cd-broadcast">
      <PermissionBoundary isLoading={dispatchQ.isLoading} error={dispatchQ.error} compact>
        <div className="flex flex-col gap-3 text-[12px]">
          {!dispatch && !dispatchEnabled && (
            <p role="status" className="text-muted-foreground">Broadcast dispatch is not enabled in this environment. Approved campaigns cannot be sent.</p>
          )}
          {!dispatch && dispatchEnabled && campaign.status !== "APPROVED" && (
            <p className="text-muted-foreground">Only approved campaigns can be scheduled. Any edit after approval sends the campaign back to review.</p>
          )}
          {!dispatch && dispatchEnabled && campaign.status === "APPROVED" && canAct && (
            <form
              className="grid grid-cols-1 gap-3 sm:grid-cols-4"
              onSubmit={(e) => {
                e.preventDefault();
                setMsg(null);
                schedule.mutate();
              }}
            >
              <EmField label="Send date" hint="Leave empty to send as soon as allowed.">
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={emInput} />
              </EmField>
              <EmField label="Local time">
                <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={emInput} disabled={!date} />
              </EmField>
              <EmField label="Time zone">
                <select value={tz ?? zone} onChange={(e) => setTz(e.target.value)} className={emInput} disabled={!date}>
                  {timeZones().map((z) => (
                    <option key={z} value={z}>{z}</option>
                  ))}
                </select>
              </EmField>
              <div className="flex items-end">
                <button type="submit" className={emBtn} disabled={schedule.isPending}>
                  <CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />
                  {date ? "Schedule broadcast" : "Send as soon as allowed"}
                </button>
              </div>
              <p className="text-muted-foreground sm:col-span-4">
                At send time CosmicForge re-checks the approval, sender, domain and every recipient&apos;s consent and suppression. Only contacts in the approved set that are still eligible receive it.
              </p>
            </form>
          )}

          {dispatch && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <EmBadge value={dispatch.status} />
                <span className="text-muted-foreground">{BROADCAST_STATUS_HELP[dispatch.status] ?? ""}</span>
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
                <dt className="text-muted-foreground">Scheduled</dt>
                <dd>{formatFullDate(dispatch.scheduledFor)}{dispatch.localSendTime ? ` (${dispatch.localSendTime.replace("T", " ")} ${dispatch.timeZone})` : ""}</dd>
                <dt className="text-muted-foreground">Recipients</dt>
                <dd>{dispatch.recipientCount} sendable · {dispatch.excludedCount} excluded</dd>
                <dt className="text-muted-foreground">Provider</dt>
                <dd>{dispatch.providerStatus ?? "not contacted"}</dd>
                <dt className="text-muted-foreground">Handed to provider</dt>
                <dd>{dispatch.providerHandoffAt ? formatFullDate(dispatch.providerHandoffAt) : "no"}</dd>
              </dl>
              {dispatch.lastErrorCode && <p className="text-amber-700">Last condition: {dispatch.lastErrorCode.replace(/_/g, " ").toLowerCase()}</p>}
              {canAct && ACTIVE.has(dispatch.status) && !dispatch.cancelRequestedAt && (
                <div className="flex flex-wrap gap-2">
                  {["SCHEDULED", "QUEUED", "PREPARING"].includes(dispatch.status) && !dispatch.providerHandoffAt && (
                    <button type="button" className={emBtnOutline} onClick={() => pause.mutate()} disabled={pause.isPending}>
                      <PauseCircle className="h-3.5 w-3.5" aria-hidden="true" /> Pause
                    </button>
                  )}
                  {dispatch.status === "PAUSED" && (
                    <button type="button" className={emBtnOutline} onClick={() => resume.mutate()} disabled={resume.isPending}>
                      <PlayCircle className="h-3.5 w-3.5" aria-hidden="true" /> Resume
                    </button>
                  )}
                  {!confirmCancel ? (
                    <button type="button" className={emBtnOutline} onClick={() => setConfirmCancel(true)}>
                      <XCircle className="h-3.5 w-3.5" aria-hidden="true" /> Cancel broadcast
                    </button>
                  ) : (
                    <form
                      className="flex w-full flex-col gap-2 rounded-md border border-red-200 bg-red-50/40 p-3"
                      onSubmit={(e) => {
                        e.preventDefault();
                        cancel.mutate();
                      }}
                    >
                      <p className="font-semibold text-red-700">
                        {dispatch.status === "SENDING"
                          ? "The provider is already sending. Emails already sent cannot be recalled; only unsent mail is stopped."
                          : "Nothing has been sent yet. Cancelling stops this broadcast permanently."}
                      </p>
                      <EmField label="Reason (optional)">
                        <input value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} className={emInput} maxLength={200} />
                      </EmField>
                      <div className="flex gap-2">
                        <button type="submit" className={emBtn} disabled={cancel.isPending}>Confirm cancel</button>
                        <button type="button" className={emBtnOutline} onClick={() => setConfirmCancel(false)}>Keep broadcast</button>
                      </div>
                    </form>
                  )}
                </div>
              )}
              {dispatch.cancelRequestedAt && ACTIVE.has(dispatch.status) && <p role="status" className="text-muted-foreground">Cancellation requested; the worker is stopping this broadcast.</p>}
            </>
          )}
          <EmMessage message={msg?.text ?? null} tone={msg?.tone} />

          {reportQ.data && (
            <section aria-labelledby="cd-report" className="mt-1 border-t border-border pt-3">
              <h3 id="cd-report" className="mb-2 font-semibold">Delivery report</h3>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                {[
                  ["Handed to provider", reportQ.data.totals.handedToProvider],
                  ["Delivered", reportQ.data.counts.DELIVERED ?? 0],
                  ["Bounced", reportQ.data.counts.BOUNCED ?? 0],
                  ["Complaints", reportQ.data.counts.COMPLAINED ?? 0],
                  ["Outcome unknown", reportQ.data.totals.outcomeUnknown],
                ].map(([label, value]) => (
                  <div key={label as string} className="rounded-md border border-border p-2">
                    <div className="text-[10px] text-muted-foreground">{label}</div>
                    <div className="text-[15px] font-semibold">{value}</div>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-muted-foreground">
                Delivered {reportQ.data.rates.deliveredPercent ?? "–"}% · bounce {reportQ.data.rates.bouncePercent ?? "–"}% · complaints {reportQ.data.rates.complaintPercent ?? "–"}% · opens {reportQ.data.rates.openPercentIndicative ?? "–"}% and clicks {reportQ.data.rates.clickPercentIndicative ?? "–"}% (indicative only).
              </p>
              <p className="text-muted-foreground">Accepted by the provider is not the same as delivered; {reportQ.data.totals.awaitingDeliveryEvidence} recipient(s) have no delivery evidence yet.</p>
              {reportQ.data.replied ? (
                <p className="text-muted-foreground">
                  Replied: <strong className="text-foreground">{reportQ.data.replied.replied}</strong>
                  {reportQ.data.rates.replyPercent != null ? ` (${reportQ.data.rates.replyPercent}% of ${reportQ.data.replied.denominator})` : ""} within {reportQ.data.replied.window.days} days of sending. Counts distinct recipients whose reply reached this campaign&apos;s reply mailbox.
                </p>
              ) : (
                <p className="text-muted-foreground">Reply reporting is not available yet.</p>
              )}
              {reportQ.data.exclusions.length > 0 && (
                <p className="mt-1 text-muted-foreground">Excluded: {reportQ.data.exclusions.map((e) => `${e.reason.replace(/_/g, " ").toLowerCase()} ${e.count}`).join(" · ")}</p>
              )}
            </section>
          )}

          {dispatch && (
            <section aria-labelledby="cd-recipients" className="border-t border-border pt-3">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <h3 id="cd-recipients" className="font-semibold">Recipients</h3>
                <label className="ml-auto flex items-center gap-1 text-muted-foreground">
                  Status
                  <select value={recipientFilter} onChange={(e) => setRecipientFilter(e.target.value)} className="rounded border border-border bg-card px-1 py-0.5">
                    <option value="">All</option>
                    {["PROVIDER_ACCEPTED", "DELIVERED", "BOUNCED", "COMPLAINED", "EXCLUDED", "UNSUBSCRIBED", "FAILED", "OUTCOME_UNKNOWN"].map((s) => (
                      <option key={s} value={s}>{s.replace(/_/g, " ").toLowerCase()}</option>
                    ))}
                  </select>
                </label>
              </div>
              <PermissionBoundary isLoading={recipientsQ.isLoading} error={recipientsQ.error} compact>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[420px] text-left">
                    <thead className="text-[11px] text-muted-foreground">
                      <tr><th className="py-1 font-semibold">Email</th><th className="font-semibold">Status</th><th className="font-semibold">Reason / last event</th></tr>
                    </thead>
                    <tbody>
                      {(recipientsQ.data?.items ?? []).length === 0 && (
                        <tr><td colSpan={3} className="py-2 text-muted-foreground">No recipients yet. They are frozen when the worker prepares the send.</td></tr>
                      )}
                      {(recipientsQ.data?.items ?? []).map((r) => (
                        <tr key={r.id} className="border-t border-border">
                          <td className="py-1">{r.email}</td>
                          <td><EmBadge value={r.status} /></td>
                          <td className="text-muted-foreground">{r.exclusionReason?.replace(/_/g, " ").toLowerCase() ?? r.lastEventType ?? "–"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </PermissionBoundary>
            </section>
          )}
          {!dispatch && !canAct && <p className="text-muted-foreground"><Send className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />Brand authors or reviewers schedule approved campaigns.</p>}
        </div>
      </PermissionBoundary>
    </EmCard>
  );
}
