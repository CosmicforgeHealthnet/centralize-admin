"use client";

import React, { useEffect, useState } from "react";
import { Eye, EyeOff, Download, Loader2 } from "lucide-react";
import { useProfileStore } from "@/stores/profile.store";
import type { Document } from "@/types/profile.types";

// ── Skeleton ──────────────────────────────────────────────────────────────────

function DocumentRowSkeleton() {
  return (
    <div className="flex items-center justify-between py-4 border-b border-border">
      <div className="flex items-center gap-2">
        <div className="w-48 h-3 bg-muted rounded animate-pulse" />
        <div className="w-8 h-3 bg-muted rounded animate-pulse" />
      </div>
      <div className="flex items-center gap-3 ml-4">
        <div className="w-4 h-4 bg-muted rounded animate-pulse" />
        <div className="w-4 h-4 bg-muted rounded animate-pulse" />
      </div>
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-64 gap-4">
      <img
        src="/no_data_found.png"
        alt="No documents found"
        className="w-[120px] h-auto object-contain"
      />
      <p className="text-[13px] font-poppins text-muted-foreground">
        This User has no Documents yet.
      </p>
    </div>
  );
}

// ── Document row ──────────────────────────────────────────────────────────────

function DocumentRow({ doc, onDownload }: { doc: Document; onDownload: (id: string) => Promise<void> }) {
  const [visible, setVisible] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const handleDownload = async () => {
    setDownloading(true);
    try {
      await onDownload(doc.id);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="flex items-center justify-between py-4 border-b border-border last:border-0">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-[13px] font-poppins font-semibold text-foreground truncate">
          {visible ? doc.name : "••••••••••"}
        </span>
        <span className="text-[11px] font-poppins text-muted-foreground shrink-0">
          {visible ? `.${doc.type}` : "••••"}
        </span>
      </div>
      <div className="flex items-center gap-3 shrink-0 ml-4">
        <button
          onClick={() => setVisible((v) => !v)}
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          {visible ? <Eye size={16} /> : <EyeOff size={16} />}
        </button>
        <button
  onClick={() => window.open(doc.url ?? "", "_blank", "noopener,noreferrer")}
  className="text-muted-foreground hover:text-foreground transition-colors"
>
  <Download size={16} />
</button>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function DocumentsTab() {
  const { profile, isLoading, fetchProfile, downloadDocument } = useProfileStore();

  useEffect(() => {
    if (!profile) fetchProfile();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleDownload = async (documentId: string) => {
    const url = await downloadDocument(documentId);
    // Open the signed URL in a new tab — browser handles the download
    window.open(url, "_blank", "noopener,noreferrer");
  };

  if (isLoading || !profile) {
    return (
      <div className="flex flex-col flex-1 min-w-0">
        {[...Array(4)].map((_, i) => <DocumentRowSkeleton key={i} />)}
      </div>
    );
  }

  if (profile.documents.length === 0) {
    return <EmptyState />;
  }

  return (
    <div className="flex flex-col flex-1 min-w-0">
      {profile.documents.map((doc) => (
        <DocumentRow key={doc.id} doc={doc} onDownload={handleDownload} />
      ))}
    </div>
  );
}