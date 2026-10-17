"use client";

import { useState } from "react";
import { ShieldAlert, Eye } from "lucide-react";

interface SensitiveContentBannerProps {
  canReveal: boolean;
  classification?: string;
  onReveal?: () => void;
  children?: React.ReactNode;
}

export default function SensitiveContentBanner({ canReveal, classification, onReveal, children }: SensitiveContentBannerProps) {
  const [revealed, setRevealed] = useState(false);

  if (revealed && children) return <>{children}</>;

  return (
    <div className="bg-red-500/5 border border-red-500/20 rounded-xl p-3 flex items-center justify-between gap-3">
      <div className="flex items-start gap-2">
        <ShieldAlert className="w-3.5 h-3.5 text-red-500 mt-0.5 shrink-0" />
        <div>
          <p className="font-poppins text-[12px] font-medium text-foreground">Restricted content</p>
          <p className="font-poppins text-[11px] text-muted-foreground mt-0.5">
            {classification ? `Classified as ${classification.replace(/_/g, " ").toLowerCase()}.` : "This content is hidden by policy."}
            {" "}Requires authorized access to view.
          </p>
        </div>
      </div>
      {canReveal && (
        <button
          onClick={() => { setRevealed(true); onReveal?.(); }}
          className="font-poppins text-[11px] font-medium text-red-600 inline-flex items-center gap-1 shrink-0"
        >
          <Eye className="w-3 h-3" /> Reveal
        </button>
      )}
    </div>
  );
}