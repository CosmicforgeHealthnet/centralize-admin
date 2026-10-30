"use client";

import Image from "next/image";
import { FileText } from "lucide-react";
import type { PharmacyDocument } from "@/types/healthnet.types";

interface Props {
  documents: PharmacyDocument[];
}

function isImageUrl(url: string) {
  return /\.(jpg|jpeg|png|webp|gif|svg)(\?.*)?$/i.test(url);
}

export default function PharmacyDocumentsTab({ documents }: Props) {
  if (documents.length === 0) {
    return (
      <p className="text-[13px] font-poppins text-muted-foreground text-center py-8">
        No documents available.
      </p>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
      {documents.map((doc) => (
        <div
          key={doc.id}
          className="flex flex-col gap-0 rounded-[12px] overflow-hidden border border-border shadow-[0_1px_8px_0_rgba(0,0,0,0.05)] dark:shadow-[0_1px_8px_0_rgba(0,0,0,0.2)]"
        >
          {/* Preview */}
          <div className="relative w-full h-[160px] bg-muted overflow-hidden">
            {doc.fileUrl && isImageUrl(doc.fileUrl) ? (
              <Image
                src={doc.fileUrl}
                alt={doc.label ?? "Document"}
                fill
                className="object-cover"
                onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center bg-muted">
                <FileText className="w-10 h-10 text-muted-foreground/50" />
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between px-3.5 py-2.5 bg-card border-t border-border">
            <div className="flex flex-col gap-0.5">
              <span className="text-[11px] font-poppins font-semibold text-foreground">
                {doc.label ?? "Document"}
              </span>
              {doc.fileSizeMb !== null && (
                <span className="text-[10px] font-poppins text-muted-foreground">
                  {doc.fileSizeMb} MB
                </span>
              )}
            </div>
            {doc.fileUrl && (
              <a
                href={doc.fileUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="w-7 h-7 flex items-center justify-center rounded-[6px] hover:bg-muted transition-colors"
              >
                <FileText className="w-4 h-4 text-muted-foreground hover:text-primary transition-colors" />
              </a>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}