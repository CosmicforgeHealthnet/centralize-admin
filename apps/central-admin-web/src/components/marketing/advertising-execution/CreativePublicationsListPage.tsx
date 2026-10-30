"use client";

import { useEffect, useState } from "react";
import { fetchAECreativePublications } from "@/lib/advertising-execution.service";
import type { AECreativePublicationListItem, AECreativeReviewStatus } from "@/types/advertising-execution.types";

function ReviewStatusBadge({ status }: { status: AECreativeReviewStatus }) {
  const tone: Record<AECreativeReviewStatus, string> = {
    PENDING_REVIEW: "bg-blue-100 text-blue-700",
    APPROVED: "bg-emerald-100 text-emerald-700",
    REJECTED: "bg-red-100 text-red-700",
    LIMITED: "bg-amber-100 text-amber-700",
    UNKNOWN: "bg-purple-100 text-purple-700",
  };
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 font-poppins text-[10px] font-medium ${tone[status]}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

export default function CreativePublicationsListPage() {
  const [publications, setPublications] = useState<AECreativePublicationListItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    fetchAECreativePublications().then((res) => {
      if (mounted) {
        setPublications(res);
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
          <div key={i} className="h-20 rounded-[10px] bg-muted/40 animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <h2 className="font-poppins text-[14px] font-semibold text-foreground">Creative Publications</h2>

      {publications.length === 0 ? (
        <p className="font-poppins text-[12px] text-muted-foreground">
          No provider publication revisions yet. Publications are created from within a plan&apos;s creative selection step.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {publications.map((pub) => (
            <div key={pub.id} className="rounded-[10px] border border-border bg-card p-4 flex items-start justify-between flex-wrap gap-2">
              <div className="flex flex-col gap-1">
                <span className="font-poppins text-[13px] font-medium text-foreground">{pub.sourceAssetName}</span>
                <span className="font-poppins text-[11px] text-muted-foreground">
                  {pub.provider} · {pub.accountLabel ?? "No account"} · rev {pub.revision} · {pub.format}
                </span>
                {pub.destinationDomain && (
                  <span className="font-poppins text-[11px] text-muted-foreground">→ {pub.destinationDomain}</span>
                )}
              </div>
              <div className="flex flex-col items-end gap-1">
                <ReviewStatusBadge status={pub.reviewStatus} />
                <span className="font-poppins text-[10px] text-muted-foreground">{pub.reuseClassification}</span>
              </div>
              {pub.reviewStatus === "REJECTED" && (
                <div className="w-full">
                  <p className="font-poppins text-[11px] text-red-600">
                    Rejected revisions cannot be edited in place. Create a new human-reviewed revision from the plan&apos;s
                    creative selection step.
                  </p>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}