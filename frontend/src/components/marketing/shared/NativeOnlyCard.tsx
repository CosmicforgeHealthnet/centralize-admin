"use client";

import { ExternalLink, Info } from "lucide-react";

interface NativeOnlyCardProps {
  actionLabel: string;
  reason?: string;
  providerUrl?: string;
}

export default function NativeOnlyCard({ actionLabel, reason, providerUrl }: NativeOnlyCardProps) {
  return (
    <div className="bg-purple-500/5 border border-purple-500/20 rounded-xl p-3 flex flex-col gap-2">
      <div className="flex items-start gap-2">
        <Info className="w-3.5 h-3.5 text-purple-500 mt-0.5 shrink-0" />
        <div>
          <p className="font-poppins text-[12px] font-medium text-foreground">{actionLabel} isn't available here</p>
          <p className="font-poppins text-[11px] text-muted-foreground mt-0.5">
            {reason ?? "This provider doesn't expose this action through the approved API."}
          </p>
        </div>
      </div>
      {providerUrl && (
        <a
          href={providerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="font-poppins text-[11px] font-medium text-purple-600 inline-flex items-center gap-1 w-fit"
        >
          Open in provider <ExternalLink className="w-3 h-3" />
        </a>
      )}
    </div>
  );
}