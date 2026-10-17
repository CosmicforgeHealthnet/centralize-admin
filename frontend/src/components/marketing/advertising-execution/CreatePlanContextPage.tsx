"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { createAEPlan } from "@/lib/advertising-execution.service";
import type { AEPlanContextPayload, AEProvider, AESource } from "@/types/advertising-execution.types";

interface CreatePlanContextPageProps {
  onCreated: (planId: string) => void;
  onCancel: () => void;
}

const PROVIDER_OPTIONS: AEProvider[] = ["META", "TIKTOK", "X", "LINKEDIN", "GOOGLE_ADS"];

export default function CreatePlanContextPage({ onCreated, onCancel }: CreatePlanContextPageProps) {
  const [provider, setProvider] = useState<AEProvider | "">("");
  const [connectionId, setConnectionId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = provider && connectionId && accountId && name.trim().length > 0;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const payload: AEPlanContextPayload = {
        provider: provider as AEProvider,
        connectionId,
        accountId,
        name: name.trim(),
        description: description.trim() || undefined,
        source: "MANUAL" as AESource,
      };
      const plan = await createAEPlan(payload);
      onCreated(plan.id);
    } catch {
      setError("Could not create the plan. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 max-w-xl">
      <div className="flex items-center justify-between">
        <h2 className="font-poppins text-[14px] font-semibold text-foreground">Create Plan — Context</h2>
        <button onClick={onCancel} className="text-muted-foreground hover:text-foreground">
          <X className="w-4 h-4" />
        </button>
      </div>

      <p className="font-poppins text-[12px] text-muted-foreground">
        One provider, connection and account per plan. This step only saves a DRAFT — no provider write occurs.
      </p>

      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <label className="font-poppins text-[11px] font-medium text-foreground">Provider</label>
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value as AEProvider)}
            className="rounded-[8px] border border-border px-3 py-2 font-poppins text-[12px] bg-card"
          >
            <option value="">Select a provider...</option>
            {PROVIDER_OPTIONS.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="font-poppins text-[11px] font-medium text-foreground">Connection</label>
          <input
            value={connectionId}
            onChange={(e) => setConnectionId(e.target.value)}
            placeholder="conn-meta-1"
            className="rounded-[8px] border border-border px-3 py-2 font-poppins text-[12px] bg-card outline-none"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="font-poppins text-[11px] font-medium text-foreground">Advertiser Account</label>
          <input
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            placeholder="act_1234567890"
            className="rounded-[8px] border border-border px-3 py-2 font-poppins text-[12px] bg-card outline-none"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="font-poppins text-[11px] font-medium text-foreground">Plan Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Q3 Search - Cardiology Awareness"
            className="rounded-[8px] border border-border px-3 py-2 font-poppins text-[12px] bg-card outline-none"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="font-poppins text-[11px] font-medium text-foreground">Description (optional)</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="rounded-[8px] border border-border px-3 py-2 font-poppins text-[12px] bg-card outline-none resize-none"
          />
        </div>
      </div>

      {error && <p className="font-poppins text-[12px] text-red-600">{error}</p>}

      <div className="flex items-center gap-2">
        <button
          onClick={handleSubmit}
          disabled={!canSubmit || submitting}
          className="rounded-[8px] bg-primary px-4 py-2 font-poppins text-[12px] font-medium text-white disabled:opacity-50"
        >
          {submitting ? "Creating..." : "Save Draft & Continue"}
        </button>
        <button
          onClick={onCancel}
          className="rounded-[8px] border border-border px-4 py-2 font-poppins text-[12px] font-medium text-foreground"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}