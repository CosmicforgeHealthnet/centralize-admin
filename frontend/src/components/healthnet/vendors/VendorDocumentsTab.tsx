"use client";

import { FileText } from "lucide-react";

interface DocCard {
  label: string;
  fileSize: string;
  imageBg: string;
}

const DOCS: DocCard[] = [
  { label: "Government Approved I.D", fileSize: "4MB", imageBg: "bg-[#e8e4d4]" },
  { label: "Registration Document",   fileSize: "4MB", imageBg: "bg-[#e8e4d4]" },
  { label: "License",                 fileSize: "4MB", imageBg: "bg-[#e8e4d4]" },
];

function DocCard({ label, fileSize, imageBg }: DocCard) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[13px] font-poppins font-semibold text-foreground">{label}</p>
      <div className="rounded-[12px] overflow-hidden border border-border">
        {/* Preview area */}
        <div className={`${imageBg} h-[160px] sm:h-[180px] flex items-center justify-center`}>
          <div className="w-16 h-16 rounded-full bg-white/40 flex items-center justify-center">
            <FileText className="w-7 h-7 text-foreground/40" />
          </div>
        </div>
        {/* Footer */}
        <div className="flex items-center justify-between px-3 py-2.5 bg-card border-t border-border">
          <span className="text-[12px] font-poppins text-muted-foreground">{fileSize}</span>
          <button className="w-7 h-7 flex items-center justify-center rounded-[6px] hover:bg-muted transition-colors">
            <FileText className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>
      </div>
    </div>
  );
}

export default function VendorDocumentsTab() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
      {DOCS.map((doc) => (
        <DocCard key={doc.label} {...doc} />
      ))}
    </div>
  );
}