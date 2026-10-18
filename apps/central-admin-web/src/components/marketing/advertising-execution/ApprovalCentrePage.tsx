"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Clock } from "lucide-react";
import { fetchAEApprovalQueue } from "@/lib/advertising-execution.service";
import type { AEApprovalQueueItem } from "@/types/advertising-execution.types";

interface ApprovalCentrePageProps {
  onOpenPacket: (planId: string) => void;
}

export default function ApprovalCentrePage({ onOpenPacket }: ApprovalCentrePageProps) {
  const [items, setItems] = useState<AEApprovalQueueItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    fetchAEApprovalQueue().then((res) => {
      if (mounted) {
        setItems(res);
        setLoading(false);
      }
    });
    return () => {
      mounted = false;
    };
  }, []);

  if (loading) {
    return (
      <div className="flex flex-col gap-3">
        {[...Array(2)].map((_, i) => (
          <div key={i} className="h-24 rounded-[10px] bg-muted/40 animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="font-poppins text-[14px] font-semibold text-foreground">Approval Centre</h2>
        <span className="font-poppins text-[11px] text-muted-foreground">{items.length} awaiting decision</span>
      </div>

      {items.length === 0 ? (
        <p className="font-poppins text-[12px] text-muted-foreground">No packets are currently awaiting approval.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {items.map((item) => (
            <button
              key={item.planId}
              onClick={() => onOpenPacket(item.planId)}
              className="text-left rounded-[10px] border border-border bg-card p-4 flex flex-col gap-2.5 hover:border-primary/40 transition-colors"
            >
              <div className="flex items-start justify-between flex-wrap gap-2">
                <div className="flex flex-col">
                  <span className="font-poppins text-[13px] font-semibold text-foreground">{item.planName}</span>
                  <span className="font-poppins text-[11px] text-muted-foreground">
                    {item.provider} · {item.accountLabel ?? "No account"} · by {item.authorLabel}
                  </span>
                </div>
                {!item.currentUserEligible && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 font-poppins text-[10px] text-muted-foreground">
                    Not eligible to approve
                  </span>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-4">
                <div className="flex flex-col">
                  <span className="font-poppins text-[10px] text-muted-foreground">Approval Progress</span>
                  <span className="font-poppins text-[12px] font-medium text-foreground">
                    {item.approvalProgress.approved}/{item.approvalProgress.required}
                  </span>
                </div>
                {item.spendExposure && (
                  <div className="flex flex-col">
                    <span className="font-poppins text-[10px] text-muted-foreground">Spend Exposure</span>
                    <span className="font-poppins text-[12px] font-medium text-foreground">{item.spendExposure}</span>
                  </div>
                )}
                {item.activationExposure && (
                  <span className="inline-flex rounded-full bg-amber-100 px-2 py-0.5 font-poppins text-[10px] text-amber-700">
                    Activation exposure
                  </span>
                )}
                {item.warningCount > 0 && (
                  <span className="flex items-center gap-1 font-poppins text-[11px] text-amber-600">
                    <AlertTriangle className="w-3 h-3" /> {item.warningCount} warning{item.warningCount > 1 ? "s" : ""}
                  </span>
                )}
                {item.validationExpiresAt && (
                  <span className="flex items-center gap-1 font-poppins text-[11px] text-muted-foreground ml-auto">
                    <Clock className="w-3 h-3" /> Expires {new Date(item.validationExpiresAt).toLocaleString()}
                  </span>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}