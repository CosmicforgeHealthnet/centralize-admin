"use client";

import { useEffect, useState } from "react";
import { fetchAECreativePublications } from "@/lib/advertising-execution.service";
import type { AECreativePublicationListItem } from "@/types/advertising-execution.types";

interface CreativeSelectionPanelProps {
  onSelect: (publicationId: string | null) => void;
  onCreateNew: () => void;
}

export default function CreativeSelectionPanel({ onSelect, onCreateNew }: CreativeSelectionPanelProps) {
  const [publications, setPublications] = useState<AECreativePublicationListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    fetchAECreativePublications().then((res) => {
      if (mounted) setPublications(res.filter((p) => p.reviewStatus === "APPROVED"));
    });
    return () => {
      mounted = false;
    };
  }, []);

  const handleSelect = (id: string) => {
    setSelectedId(id);
    onSelect(id);
  };

  return (
    <div className="rounded-[10px] border border-border bg-card p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="font-poppins text-[12px] font-semibold text-foreground">Creative Selection</h3>
        <button onClick={onCreateNew} className="font-poppins text-[11px] text-primary hover:underline">
          Create new publication revision
        </button>
      </div>

      {publications.length === 0 ? (
        <p className="font-poppins text-[12px] text-muted-foreground">
          No approved provider publications available yet for this account.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {publications.map((pub) => (
            <button
              key={pub.id}
              onClick={() => handleSelect(pub.id)}
              className={`text-left rounded-[8px] border p-3 flex items-center justify-between ${
                selectedId === pub.id ? "border-primary bg-primary/5" : "border-border hover:bg-muted/30"
              }`}
            >
              <div className="flex flex-col">
                <span className="font-poppins text-[12px] font-medium text-foreground">{pub.sourceAssetName}</span>
                <span className="font-poppins text-[10px] text-muted-foreground">
                  {pub.format} · rev {pub.revision} · {pub.reuseClassification}
                </span>
              </div>
              <span className="inline-flex rounded-full bg-emerald-100 px-2 py-0.5 font-poppins text-[10px] text-emerald-700">
                Approved
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}