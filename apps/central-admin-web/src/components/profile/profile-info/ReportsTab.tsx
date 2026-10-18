"use client";

import React, { useState, useRef, useEffect } from "react";
import { Eye, EyeOff, Download, Loader2, MoreHorizontal, Pencil, Trash2, FileText } from "lucide-react";
import { useProfileStore } from "@/stores/profile.store";
import type { Report } from "@/types/profile.types";

export type { Report };

function ReportRow({
  report,
  onEdit,
}: {
  report: Report;
  onEdit: (report: Report) => void;
}) {
  const [visible, setVisible] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const { downloadReport, deleteReport } = useProfileStore();

  const hasAttachment = report.url && report.type && report.type !== "text";

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleDownload = async () => {
    if (!hasAttachment) return;
    setMenuOpen(false);
    setIsDownloading(true);
    try {
      const url = await downloadReport(report.id);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch {}
    finally { setIsDownloading(false); }
  };

  const handleDelete = () => {
    setMenuOpen(false);
    setShowDeleteConfirm(true);
  };

  const confirmDelete = async () => {
    setShowDeleteConfirm(false);
    setIsDeleting(true);
    try {
      await deleteReport(report.id);
    } catch {}
    finally { setIsDeleting(false); }
  };

  return (
    <>
      <div className="flex items-center justify-between py-4 border-b border-border last:border-0">
        <div className="flex flex-col gap-0.5 min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[13px] font-poppins font-semibold text-foreground truncate">
              {visible ? report.title : "••••••••••"}
            </span>
            {hasAttachment && (
              <span className="text-[11px] font-poppins text-muted-foreground shrink-0">
                {visible ? `.${report.type}` : "••••"}
              </span>
            )}
            {!hasAttachment && (
              <span className="text-[11px] font-poppins text-muted-foreground shrink-0 flex items-center gap-1">
                <FileText size={11} />
                No file
              </span>
            )}
          </div>
          <span className="text-[11px] font-poppins text-muted-foreground">
            {visible ? report.date : "••••"}
          </span>
        </div>

        <div className="flex items-center gap-3 shrink-0 ml-4">
          <button
            onClick={() => setVisible((v) => !v)}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            {visible ? <Eye size={16} /> : <EyeOff size={16} />}
          </button>

          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setMenuOpen((v) => !v)}
              disabled={isDeleting || isDownloading}
              className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
            >
              {isDeleting || isDownloading
                ? <Loader2 size={16} className="animate-spin" />
                : <MoreHorizontal size={16} />}
            </button>

            {menuOpen && (
              <div className="absolute right-0 top-6 z-50 w-[148px] bg-background border border-border rounded-[10px] shadow-md overflow-hidden">
                <button
                  onClick={() => { setMenuOpen(false); onEdit(report); }}
                  className="flex items-center gap-2.5 w-full px-4 py-2.5 text-[13px] font-poppins text-foreground hover:bg-muted transition-colors"
                >
                  <Pencil size={14} />
                  Edit
                </button>
                <button
                  onClick={handleDownload}
                  disabled={!hasAttachment}
                  className={`flex items-center gap-2.5 w-full px-4 py-2.5 text-[13px] font-poppins transition-colors ${
                    hasAttachment
                      ? "text-foreground hover:bg-muted"
                      : "text-muted-foreground cursor-not-allowed opacity-50"
                  }`}
                >
                  <Download size={14} />
                  Download
                </button>
                <button
                  onClick={handleDelete}
                  className="flex items-center gap-2.5 w-full px-4 py-2.5 text-[13px] font-poppins text-destructive hover:bg-muted transition-colors"
                >
                  <Trash2 size={14} />
                  Delete
                </button>
                {/* <button
  onClick={() => { setMenuOpen(false); window.open(report.url!, "_blank", "noopener,noreferrer"); }}
  disabled={!hasAttachment}
  className={`flex items-center gap-2.5 w-full px-4 py-2.5 text-[13px] font-poppins transition-colors ${
    hasAttachment
      ? "text-foreground hover:bg-muted"
      : "text-muted-foreground cursor-not-allowed opacity-50"
  }`}
>
  <Eye size={14} />
  View
</button> */}
              </div>
            )}
          </div>
        </div>
      </div>

      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-background border border-border rounded-[14px] shadow-lg w-[340px] p-6 flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <span className="text-[15px] font-poppins font-semibold text-foreground">
                Delete report?
              </span>
              <span className="text-[13px] font-poppins text-muted-foreground leading-relaxed">
                <span className="font-medium text-foreground">{report.title}</span>
                {" "}will be permanently deleted. This cannot be undone.
              </span>
            </div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                className="px-4 py-2 text-[13px] font-poppins font-medium text-foreground bg-muted hover:bg-muted/80 rounded-[8px] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                className="px-4 py-2 text-[13px] font-poppins font-semibold text-white bg-destructive hover:opacity-90 rounded-[8px] transition-opacity"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default function ReportsTab({
  onSelectReport,
}: {
  onSelectReport: (report: Report) => void;
}) {
  const { profile } = useProfileStore();
  const reports = profile?.reports ?? [];

  return (
    <div className="flex flex-col flex-1 min-w-0">
      <div className="flex justify-end mb-4">
        <button
          onClick={() =>
            onSelectReport({
              id: "new",
              title: "",
              type: "",
              date: "",
              body: null,
              note: null,
              url: null,
            })
          }
          className="bg-primary text-white text-[13px] font-poppins font-semibold px-4 py-2.5 rounded-[10px] hover:opacity-90 transition-opacity"
        >
          Add New Report
        </button>
      </div>

      {reports.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-64 gap-4">
          <img src="/no_data_found.png" alt="No reports" className="w-[120px] h-auto object-contain" />
          <p className="text-[13px] font-poppins text-muted-foreground">No reports yet.</p>
        </div>
      ) : (
        reports.map((report) => (
          <ReportRow key={report.id} report={report} onEdit={onSelectReport} />
        ))
      )}
    </div>
  );
}