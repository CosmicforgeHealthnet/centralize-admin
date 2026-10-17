"use client";

import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { fetchAEPlanDetail, updateAEPlan } from "@/lib/advertising-execution.service";
import type {
  AEBudgetExposure,
  AEOperationType,
  AEPlanDetail,
  AEPlanItem,
  AEResourceType,
} from "@/types/advertising-execution.types";
import BudgetConfigPanel from "./BudgetConfigPanel";
import TargetingConfigPanel from "./TargetingConfigPanel";
import CreativeSelectionPanel from "./CreativeSelectionPanel";
import CreatePublicationRevisionModal from "./CreatePublicationRevisionModal";

interface PlanBuilderPageProps {
  id: string;
  onDone: () => void;
  onBack: () => void;
}

const OPERATION_TYPES: AEOperationType[] = ["CREATE", "UPDATE", "PAUSE", "RESUME", "ARCHIVE", "REMOVE_LINK"];
const RESOURCE_TYPES: AEResourceType[] = ["BUDGET", "CAMPAIGN", "GROUP", "TARGETING", "CREATIVE", "AD", "ASSET_LINK"];

export default function PlanBuilderPage({ id, onDone, onBack }: PlanBuilderPageProps) {
  const [plan, setPlan] = useState<AEPlanDetail | null>(null);
  const [items, setItems] = useState<AEPlanItem[]>([]);
  const [budgetExposure, setBudgetExposure] = useState<AEBudgetExposure[]>([]);
  const [saving, setSaving] = useState(false);
  const [creativeModalForItemId, setCreativeModalForItemId] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    fetchAEPlanDetail(id).then((res) => {
      if (mounted) {
        setPlan(res);
        setItems(res.items);
        setBudgetExposure(res.budgetExposure);
      }
    });
    return () => {
      mounted = false;
    };
  }, [id]);

  const addItem = () => {
    setItems((prev) => [
      ...prev,
      {
        id: "new-" + Date.now(),
        clientReference: `item-${prev.length + 1}`,
        operationType: "UPDATE",
        resourceType: "BUDGET",
        existingProviderResourceId: null,
        dependsOnClientReferences: [],
        intent: {},
        beforeState: null,
        materialHash: null,
      },
    ]);
  };

  const removeItem = (itemId: string) => {
    setItems((prev) => prev.filter((i) => i.id !== itemId));
    setBudgetExposure((prev) => prev.filter((_, idx) => items[idx]?.id !== itemId));
  };

  const updateItemField = (itemId: string, field: keyof AEPlanItem, value: unknown) => {
    setItems((prev) => prev.map((i) => (i.id === itemId ? { ...i, [field]: value } : i)));
  };

  const getOrCreateBudgetExposure = (item: AEPlanItem): AEBudgetExposure => {
    const existing = budgetExposure.find((b) => (item.intent as any)?.__exposureRef === b);
    if (existing) return existing;
    return {
      currency: plan?.currency ?? "USD",
      currentValue: (item.beforeState?.dailyAmount as string) ?? null,
      proposedValue: (item.intent?.dailyAmount as string) ?? "0.00",
      budgetType: "DAILY",
      deltaAbsolute: null,
      deltaPct: null,
      policyCap: null,
      sharedBudgetImpact: [],
      approvalRequired: true,
    };
  };

  const handleBudgetChange = (itemId: string, exposure: AEBudgetExposure) => {
    updateItemField(itemId, "intent", { ...items.find((i) => i.id === itemId)?.intent, dailyAmount: exposure.proposedValue });
    setBudgetExposure((prev) => {
      const item = items.find((i) => i.id === itemId);
      const idx = items.findIndex((i) => i.id === itemId);
      const next = [...prev];
      next[idx] = exposure;
      return next;
    });
  };

  const handleTargetingChange = (itemId: string, targeting: { locations: string[]; exclusions: string[]; scheduleNote: string }) => {
    updateItemField(itemId, "intent", { ...items.find((i) => i.id === itemId)?.intent, targeting });
  };

  const handleCreativeSelect = (itemId: string, publicationId: string | null) => {
    updateItemField(itemId, "existingProviderResourceId", publicationId);
  };

  const handleSaveAndContinue = async () => {
    if (!plan) return;
    setSaving(true);
    try {
      await updateAEPlan(id, { items, budgetExposure });
      onDone();
    } finally {
      setSaving(false);
    }
  };

  if (!plan) {
    return <div className="h-40 rounded-[10px] bg-muted/40 animate-pulse" />;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex flex-col">
          <h2 className="font-poppins text-[14px] font-semibold text-foreground">Plan Builder — {plan.name}</h2>
          <p className="font-poppins text-[11px] text-muted-foreground">
            {plan.provider} · {plan.currency} · Resource hierarchy (provider-neutral)
          </p>
        </div>
        <button
          onClick={addItem}
          className="flex items-center gap-1.5 rounded-[8px] border border-border px-3 py-1.5 font-poppins text-[12px] font-medium text-foreground hover:bg-muted/40"
        >
          <Plus className="w-3.5 h-3.5" /> Add Item
        </button>
      </div>

      <div className="flex flex-col gap-4">
        {items.length === 0 && (
          <p className="font-poppins text-[12px] text-muted-foreground">
            No plan items yet. Add a budget, campaign, group, targeting, creative or ad operation.
          </p>
        )}
        {items.map((item) => (
          <div key={item.id} className="rounded-[10px] border border-border bg-card p-3 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="font-poppins text-[12px] font-medium text-foreground">{item.clientReference}</span>
              <button onClick={() => removeItem(item.id)} className="text-muted-foreground hover:text-red-600">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              <div className="flex flex-col gap-1">
                <label className="font-poppins text-[10px] text-muted-foreground">Operation Type</label>
                <select
                  value={item.operationType}
                  onChange={(e) => updateItemField(item.id, "operationType", e.target.value)}
                  className="rounded-[6px] border border-border px-2 py-1.5 font-poppins text-[12px] bg-card"
                >
                  {OPERATION_TYPES.map((op) => (
                    <option key={op} value={op}>{op}</option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <label className="font-poppins text-[10px] text-muted-foreground">Resource Type</label>
                <select
                  value={item.resourceType}
                  onChange={(e) => updateItemField(item.id, "resourceType", e.target.value)}
                  className="rounded-[6px] border border-border px-2 py-1.5 font-poppins text-[12px] bg-card"
                >
                  {RESOURCE_TYPES.map((rt) => (
                    <option key={rt} value={rt}>{rt}</option>
                  ))}
                </select>
              </div>
            </div>

            {item.dependsOnClientReferences.length > 0 && (
              <span className="font-poppins text-[10px] text-muted-foreground">
                Depends on: {item.dependsOnClientReferences.join(", ")}
              </span>
            )}

            {/* Resource-type-specific configuration */}
            {item.resourceType === "BUDGET" && (
              <BudgetConfigPanel
                exposure={getOrCreateBudgetExposure(item)}
                onChange={(exposure) => handleBudgetChange(item.id, exposure)}
              />
            )}

            {(item.resourceType === "TARGETING" || item.resourceType === "CAMPAIGN" || item.resourceType === "GROUP") && (
              <TargetingConfigPanel
                accountTimezone={null}
                onChange={(targeting) => handleTargetingChange(item.id, targeting)}
              />
            )}

            {(item.resourceType === "CREATIVE" || item.resourceType === "AD" || item.resourceType === "ASSET_LINK") && (
              <CreativeSelectionPanel
                onSelect={(pubId) => handleCreativeSelect(item.id, pubId)}
                onCreateNew={() => setCreativeModalForItemId(item.id)}
              />
            )}
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={handleSaveAndContinue}
          disabled={saving || items.length === 0}
          className="rounded-[8px] bg-primary px-4 py-2 font-poppins text-[12px] font-medium text-white disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save & Continue"}
        </button>
        <button
          onClick={onBack}
          className="rounded-[8px] border border-border px-4 py-2 font-poppins text-[12px] font-medium text-foreground"
        >
          Cancel
        </button>
      </div>

      {creativeModalForItemId && (
        <CreatePublicationRevisionModal
          sourceAssetId="asset-manual"
          onCreated={(pubId) => {
            handleCreativeSelect(creativeModalForItemId, pubId);
            setCreativeModalForItemId(null);
          }}
          onClose={() => setCreativeModalForItemId(null)}
        />
      )}
    </div>
  );
}