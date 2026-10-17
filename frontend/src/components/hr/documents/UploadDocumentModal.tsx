"use client";

import { useRef, useState } from "react";
import { X, Calendar, CloudUpload } from "lucide-react";
import { useHrmStore } from "@/stores/hrm.store";
import { DOCUMENT_FORMATS, DocumentFormat } from "@/types/hrm.types";

interface Props {
  employeeId: string;
  onClose: () => void;
}

const ACCEPT_MIME = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];

export default function UploadDocumentModal({ employeeId, onClose }: Props) {
  const { uploadEmployeeDocument, isUploadingDocument, documentsError } = useHrmStore();

  const [title, setTitle] = useState("");
  const [format, setFormat] = useState<DocumentFormat | "">("");
  const [expiry, setExpiry] = useState("");
  const [dragging, setDragging] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const dropped = e.dataTransfer.files[0];
    if (dropped) setFile(dropped);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (selected) setFile(selected);
  };

  const handleUpload = async () => {
    setFormError(null);

    if (!file) {
      setFormError("Please select a file to upload.");
      return;
    }
    if (!title.trim()) {
      setFormError("Title is required.");
      return;
    }
    if (!format) {
      setFormError("Please select a format.");
      return;
    }
    if (file.size > 30 * 1024 * 1024) {
      setFormError("File exceeds the 30MB limit.");
      return;
    }

    try {
      await uploadEmployeeDocument(employeeId, {
        title: title.trim(),
        format,
        expiry: expiry || undefined,
        file,
      });
      onClose();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Upload failed");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
      <div className="bg-white dark:bg-card rounded-2xl w-full max-w-[560px] shadow-xl border border-border overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-border">
          <h2 className="font-poppins text-[16px] font-bold text-foreground">Upload Document</h2>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 flex flex-col gap-4">
          {(formError || documentsError) && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-2.5">
              <p className="font-poppins text-[12px] text-red-600">{formError ?? documentsError}</p>
            </div>
          )}

          {/* Title */}
          <div className="flex flex-col gap-1.5">
            <label className="font-poppins text-[12px] font-medium text-foreground">Title</label>
            <input
              type="text"
              placeholder="Enter Title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full h-[44px] px-3 rounded-xl border border-border bg-muted text-[12px] font-poppins text-foreground outline-none focus:border-primary/50 placeholder:text-muted-foreground transition-colors"
            />
          </div>

          {/* Format */}
          <div className="flex flex-col gap-1.5">
            <label className="font-poppins text-[12px] font-medium text-foreground">Format</label>
            <div className="relative">
              <select
                value={format}
                onChange={(e) => setFormat(e.target.value as DocumentFormat)}
                className="w-full h-[44px] px-3 rounded-xl border border-border bg-muted text-[12px] font-poppins text-foreground outline-none focus:border-primary/50 appearance-none cursor-pointer transition-colors"
              >
                <option value="" disabled>Select Format</option>
                {DOCUMENT_FORMATS.map((f) => (
                  <option key={f} value={f}>{f}</option>
                ))}
              </select>
              <svg className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </div>
          </div>

          {/* Expiry Date */}
          <div className="flex flex-col gap-1.5">
            <label className="font-poppins text-[12px] font-medium text-foreground">
              Expiry Date <span className="text-muted-foreground font-normal">(If applicable)</span>
            </label>
            <div className="relative">
              <input
                type="date"
                value={expiry}
                onChange={(e) => setExpiry(e.target.value)}
                className="w-full h-[44px] px-3 pr-10 rounded-xl border border-border bg-muted text-[12px] font-poppins text-foreground outline-none focus:border-primary/50 placeholder:text-muted-foreground transition-colors"
              />
              <Calendar className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            </div>
          </div>

          {/* Drop Zone */}
          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            onClick={() => inputRef.current?.click()}
            className={`relative flex flex-col items-center justify-center gap-2 border-2 border-dashed rounded-xl py-8 cursor-pointer transition-colors ${
              dragging ? "border-primary bg-primary/5" : "border-border hover:border-primary/40 hover:bg-muted/30"
            }`}
          >
            <input
              ref={inputRef}
              type="file"
              accept=".xls,.xlsx,.pdf,.doc,.docx"
              onChange={handleFileChange}
              className="hidden"
            />
            <div className="flex flex-col items-center gap-1">
              <div className="relative w-12 h-14 mb-1">
                <svg width="48" height="56" viewBox="0 0 48 56" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M8 0H32L48 16V52C48 54.2 46.2 56 44 56H8C5.8 56 4 54.2 4 52V4C4 1.8 5.8 0 8 0Z" fill="#E2E8F0"/>
                  <path d="M32 0L48 16H36C33.8 16 32 14.2 32 12V0Z" fill="#CBD5E1"/>
                </svg>
                <div className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-white flex items-center justify-center shadow-sm">
                  <CloudUpload className="w-3 h-3 text-primary" />
                </div>
              </div>
              <p className="font-poppins text-[13px] font-semibold text-foreground">
                {file ? file.name : "Upload file here"}
              </p>
            </div>
          </div>

          {/* File info */}
          <div className="flex items-center justify-between">
            <span className="font-poppins text-[10px] text-muted-foreground">
              Supported format: XLS, XLSX, PDF, DOC, DOCX
            </span>
            <span className="font-poppins text-[10px] text-muted-foreground">
              Maximum size: 30MB
            </span>
          </div>

          {/* Upload Button */}
          <button
            onClick={handleUpload}
            disabled={isUploadingDocument}
            className="w-full h-[50px] bg-primary text-white font-poppins text-[14px] font-semibold rounded-xl hover:bg-primary/90 transition-colors mt-1 disabled:opacity-60"
          >
            {isUploadingDocument ? "Uploading..." : "Upload"}
          </button>
        </div>
      </div>
    </div>
  );
}