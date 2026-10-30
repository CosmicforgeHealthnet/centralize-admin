"use client";

import { useEffect, useState } from "react";
import { useSocialOperationsStore } from "@/stores/social-operations.store";
import { useSocialPermissions } from "../../shared/useSocialPermissions";
import PermissionGate from "../../shared/PermissionGate";
import { Skeleton } from "@/components/ui/skeleton";

export default function SocialOperationsSettingsPage() {
  const permissions = useSocialPermissions();
  const { settings, isLoadingSettings, fetchSettings, updateSettings, actionLoading, error } = useSocialOperationsStore();
  const [draft, setDraft] = useState(settings);

  useEffect(() => {
    fetchSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  if (isLoadingSettings || !draft) {
    return <Skeleton className="h-[300px] rounded-xl" />;
  }

  const isDirty = JSON.stringify(draft) !== JSON.stringify(settings);
  const isSaving = actionLoading === "settings";

  return (
    <div className="bg-card rounded-xl border border-border p-4 flex flex-col gap-4 max-w-lg">
      {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm font-poppins">{error}</div>}

      <div className="flex items-center justify-between">
        <div>
          <p className="font-poppins text-[12px] font-medium text-foreground">Allow self-approval</p>
          <p className="font-poppins text-[10px] text-muted-foreground">Lets a submitter approve their own post</p>
        </div>
        <PermissionGate hasPermission={permissions.social_settings === "EDIT"}>
          <input
            type="checkbox"
            checked={draft.approvalSelfReviewAllowed}
            onChange={(e) => setDraft({ ...draft, approvalSelfReviewAllowed: e.target.checked })}
          />
        </PermissionGate>
      </div>

      <div className="flex flex-col gap-1">
        <label className="font-poppins text-[11px] text-muted-foreground">Default timezone</label>
        <input
          value={draft.defaultTimezone}
          onChange={(e) => setDraft({ ...draft, defaultTimezone: e.target.value })}
          className="font-poppins text-[12px] bg-background border border-border rounded-lg px-2.5 py-1.5 text-foreground"
        />
      </div>

      <div className="flex flex-col gap-1">
        <label className="font-poppins text-[11px] text-muted-foreground">Retry limit</label>
        <input
          type="number" min={0}
          value={draft.retryLimit}
          onChange={(e) => setDraft({ ...draft, retryLimit: Number(e.target.value) })}
          className="font-poppins text-[12px] bg-background border border-border rounded-lg px-2.5 py-1.5 text-foreground"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <label className="font-poppins text-[11px] text-muted-foreground">SLA first response (min)</label>
          <input
            type="number" min={0}
            value={draft.slaFirstResponseMinutes}
            onChange={(e) => setDraft({ ...draft, slaFirstResponseMinutes: Number(e.target.value) })}
            className="font-poppins text-[12px] bg-background border border-border rounded-lg px-2.5 py-1.5 text-foreground"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="font-poppins text-[11px] text-muted-foreground">SLA resolution (min)</label>
          <input
            type="number" min={0}
            value={draft.slaResolutionMinutes}
            onChange={(e) => setDraft({ ...draft, slaResolutionMinutes: Number(e.target.value) })}
            className="font-poppins text-[12px] bg-background border border-border rounded-lg px-2.5 py-1.5 text-foreground"
          />
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <label className="font-poppins text-[11px] text-muted-foreground">Retention (days)</label>
        <input
          type="number" min={0}
          value={draft.retentionDays}
          onChange={(e) => setDraft({ ...draft, retentionDays: Number(e.target.value) })}
          className="font-poppins text-[12px] bg-background border border-border rounded-lg px-2.5 py-1.5 text-foreground"
        />
      </div>

      <PermissionGate hasPermission={permissions.social_settings === "EDIT"}>
        <button
          onClick={() => updateSettings(draft)}
          disabled={!isDirty || isSaving}
          className="font-poppins text-[12px] font-medium bg-primary text-primary-foreground px-4 py-2 rounded-lg disabled:opacity-40 w-fit"
        >
          {isSaving ? "Saving…" : "Save settings"}
        </button>
      </PermissionGate>
    </div>
  );
}