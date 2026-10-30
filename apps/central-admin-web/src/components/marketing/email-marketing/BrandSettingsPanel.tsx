"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import PermissionBoundary from "@/components/mail/PermissionBoundary";
import { formatFullDate } from "@/components/mail/mail-utils";
import { classifyMailError } from "@/lib/mail.service";
import { fetchBrandSettings, fetchSenderIdentities, pauseBrandDispatch, resumeBrandDispatch, updateBrandSettings } from "@/lib/mail-marketing.service";
import type { BrandSettings, MarketingOrganization } from "@/types/mail-marketing.types";
import StepUpDialog from "./StepUpDialog";
import { EmBadge, EmCard, EmField, EmMessage, emBtn, emBtnOutline, emInput } from "./em-ui";

export default function BrandSettingsPanel({ org }: { org: MarketingOrganization }) {
  const qc = useQueryClient();
  const key = ["mail", "marketing", org.id, "settings"];
  const settingsQ = useQuery({ queryKey: key, queryFn: () => fetchBrandSettings(org.id), retry: false });
  const sendersQ = useQuery({ queryKey: ["mail", "marketing", org.id, "sender-identities"], queryFn: () => fetchSenderIdentities(org.id), retry: false, gcTime: 300000 });
  const [form, setForm] = useState<Partial<BrandSettings> | null>(null);
  const [pauseReason, setPauseReason] = useState("");
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [msg, setMsg] = useState<{ text: string; tone: "info" | "error" } | null>(null);
  const settings = settingsQ.data;
  const values = { ...settings, ...form };
  const onErr = (err: unknown) => setMsg({ text: classifyMailError(err).message, tone: "error" });
  const done = (text: string) => () => {
    setForm(null);
    setMsg({ text, tone: "info" });
    qc.invalidateQueries({ queryKey: key });
  };
  const save = useMutation({
    mutationFn: () =>
      updateBrandSettings(org.id, {
        postalAddress: values.postalAddress ?? null,
        defaultTimeZone: values.defaultTimeZone,
        dailyBroadcastCap: Number(values.dailyBroadcastCap),
        dailyAutomationCap: Number(values.dailyAutomationCap),
        maxBroadcastRecipients: Number(values.maxBroadcastRecipients),
        confirmationSenderAddressId: values.confirmationSenderAddressId ?? null,
      }),
    onSuccess: done("Settings saved."),
    onError: onErr,
  });
  const pause = useMutation({ mutationFn: () => pauseBrandDispatch(org.id, pauseReason.trim()), onSuccess: done("Brand dispatch paused. Queued broadcasts and automations wait; nothing is deleted."), onError: onErr });
  const resume = useMutation({ mutationFn: (stepUpId: string) => resumeBrandDispatch(org.id, stepUpId), onSuccess: done("Brand dispatch resumed."), onError: onErr });
  const set = (patch: Partial<BrandSettings>) => setForm((prev) => ({ ...(prev ?? {}), ...patch }));

  return (
    <div className="flex flex-col gap-4">
      <PermissionBoundary isLoading={settingsQ.isLoading} error={settingsQ.error}>
        {settings && (
          <>
            <EmCard title="Sending status" id="bs-status">
              <ul className="grid grid-cols-1 gap-1 text-[12px] sm:grid-cols-2">
                <li>Broadcast dispatch: <EmBadge value={settings.flags.broadcastDispatchEnabled ? "ACTIVE" : "DISABLED"} /></li>
                <li>Automation execution: <EmBadge value={settings.flags.automationEnabled ? "ACTIVE" : "DISABLED"} /></li>
                <li>Confirmation emails: <EmBadge value={settings.flags.confirmationEmailsEnabled ? "ACTIVE" : "DISABLED"} /></li>
                <li>Emergency stop: <EmBadge value={settings.flags.emergencyStop ? "PAUSED" : "ACTIVE"} /></li>
                <li className="sm:col-span-2">
                  Provider account: {settings.provider.configured ? `configured (${settings.provider.credentialSource})` : `not configured — set ${settings.provider.credentialEnvName} on the server`}
                </li>
              </ul>
            </EmCard>

            <EmCard title="Brand dispatch" id="bs-dispatch">
              {settings.dispatchPaused ? (
                <div className="flex flex-col gap-2 text-[12px]">
                  <p role="status" className="font-semibold text-amber-700">
                    Paused{settings.pausedAt ? ` since ${formatFullDate(settings.pausedAt)}` : ""}{settings.pausedReason ? `: ${settings.pausedReason}` : ""}
                  </p>
                  {org.canApprove ? (
                    <button type="button" className={emBtn} onClick={() => setStepUpOpen(true)} disabled={resume.isPending}>Resume dispatch (requires 2FA code)</button>
                  ) : (
                    <p className="text-muted-foreground">A brand reviewer must resume dispatch.</p>
                  )}
                </div>
              ) : (
                <form
                  className="flex flex-col gap-2 text-[12px] sm:flex-row sm:items-end"
                  onSubmit={(e) => {
                    e.preventDefault();
                    pause.mutate();
                  }}
                >
                  <EmField label="Pause all broadcasts and automations for this brand" hint="Use for deliverability problems or incidents. Nothing queued is lost.">
                    <input value={pauseReason} onChange={(e) => setPauseReason(e.target.value)} className={emInput} placeholder="Reason" minLength={5} required />
                  </EmField>
                  <button type="submit" className={emBtnOutline} disabled={pauseReason.trim().length < 5 || pause.isPending}>Pause dispatch</button>
                </form>
              )}
            </EmCard>

            <EmCard title="Brand settings" id="bs-settings">
              <form
                className="grid grid-cols-1 gap-3 sm:grid-cols-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  save.mutate();
                }}
              >
                <div className="sm:col-span-2">
                  <EmField label="Postal address (required in every marketing email)">
                    <input value={values.postalAddress ?? ""} onChange={(e) => set({ postalAddress: e.target.value })} className={emInput} disabled={!org.canApprove} maxLength={500} />
                  </EmField>
                </div>
                <EmField label="Default time zone">
                  <input value={values.defaultTimeZone ?? ""} onChange={(e) => set({ defaultTimeZone: e.target.value })} className={emInput} disabled={!org.canApprove} />
                </EmField>
                <EmField label="Double opt-in confirmation sender">
                  <select value={values.confirmationSenderAddressId ?? ""} onChange={(e) => set({ confirmationSenderAddressId: e.target.value || null })} className={emInput} disabled={!org.canApprove}>
                    <option value="">None</option>
                    {(sendersQ.data ?? []).map((s) => (
                      <option key={s.addressId} value={s.addressId}>{s.address}</option>
                    ))}
                  </select>
                </EmField>
                <EmField label="Max recipients per broadcast" hint={`Server ceiling ${settings.hardMaxBroadcastRecipients}`}>
                  <input type="number" min={0} max={settings.hardMaxBroadcastRecipients} value={values.maxBroadcastRecipients ?? 0} onChange={(e) => set({ maxBroadcastRecipients: Number(e.target.value) })} className={emInput} disabled={!org.canApprove} />
                </EmField>
                <EmField label="Daily broadcast cap (recipients / 24h)">
                  <input type="number" min={0} value={values.dailyBroadcastCap ?? 0} onChange={(e) => set({ dailyBroadcastCap: Number(e.target.value) })} className={emInput} disabled={!org.canApprove} />
                </EmField>
                <EmField label="Daily automation cap (emails / 24h)">
                  <input type="number" min={0} value={values.dailyAutomationCap ?? 0} onChange={(e) => set({ dailyAutomationCap: Number(e.target.value) })} className={emInput} disabled={!org.canApprove} />
                </EmField>
                {org.canApprove ? (
                  <div className="flex items-end sm:col-span-2">
                    <button type="submit" className={emBtn} disabled={!form || save.isPending}>Save settings</button>
                  </div>
                ) : (
                  <p className="text-[12px] text-muted-foreground sm:col-span-2">Only brand reviewers change these settings.</p>
                )}
              </form>
            </EmCard>
          </>
        )}
      </PermissionBoundary>
      <EmMessage message={msg?.text ?? null} tone={msg?.tone} />
      {stepUpOpen && (
        <StepUpDialog
          purpose="MARKETING_BROADCAST_OVERRIDE"
          title="Confirm resuming brand dispatch"
          onCancel={() => setStepUpOpen(false)}
          onVerified={async (id) => {
            await resume.mutateAsync(id);
            setStepUpOpen(false);
          }}
        />
      )}
    </div>
  );
}
