"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { Search, CreditCard, Phone, Mail, Calendar, Briefcase, MapPin, Users, FileText, RefreshCw } from "lucide-react";
import UploadDocumentModal from "./UploadDocumentModal";
import { useHrmStore } from "@/stores/hrm.store";

const FILTER_OPTIONS: { label: string; value: "type" | "date" | "" }[] = [
  { label: "Title / Name", value: "" },
  { label: "Type", value: "type" },
  { label: "Date", value: "date" },
];

function formatDate(iso: string | null | undefined) {
  if (!iso) return "Not Applicable";
  try {
    return new Date(iso).toLocaleDateString("en-GB");
  } catch {
    return "Not Applicable";
  }
}

// ─── Action Dropdown ──────────────────────────────────────────────────────────

function ActionMenu({
  onClose,
  onPreview,
  onDownload,
  onDelete,
}: {
  onClose: () => void;
  onPreview: () => void;
  onDownload: () => void;
  onDelete: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="absolute right-0 top-8 z-20 bg-card border border-border rounded-xl shadow-lg py-1 min-w-[130px]"
    >
      {[
        { label: "Preview", action: onPreview },
        { label: "Download", action: onDownload },
        { label: "Delete", action: onDelete },
      ].map(({ label, action }) => (
        <button
          key={label}
          onClick={() => { action(); onClose(); }}
          className="w-full text-left px-4 py-2.5 font-poppins text-[12px] text-foreground hover:bg-muted/50 transition-colors"
        >
          {label}
        </button>
      ))}
    </div>
  );
}

// ─── Left Panel ───────────────────────────────────────────────────────────────

function LeftPanel({ emp }: { emp: { name: string; employeeCode: string | null; phone: string | null; email: string; employmentDate: string | null; position: string | null; location: string | null; headOfDepartment: string | null; avatarUrl: string | null } }) {
  return (
    <div className="flex flex-col gap-3 w-full md:w-[175px] md:shrink-0">
      <div className="w-full md:w-[175px] h-[180px] rounded-xl overflow-hidden bg-muted flex items-center justify-center">
        {emp.avatarUrl ? (
          <Image src={emp.avatarUrl} alt={emp.name} width={175} height={180} className="object-cover w-full h-full" />
        ) : (
          <div className="w-full h-full bg-primary/10 flex items-center justify-center">
            <span className="text-[40px] font-poppins font-bold text-primary">{emp.name.charAt(0)}</span>
          </div>
        )}
      </div>
      <div className="bg-card rounded-xl border border-border p-3 flex flex-col gap-2.5">
        {[
          { icon: <CreditCard className="w-3.5 h-3.5" />, label: "Employee ID:", value: emp.employeeCode ?? "—" },
          { icon: <Phone className="w-3.5 h-3.5" />, label: "Phone Number:", value: emp.phone ?? "—" },
          { icon: <Mail className="w-3.5 h-3.5" />, label: "Email Address:", value: emp.email },
          { icon: <Calendar className="w-3.5 h-3.5" />, label: "Employment Date:", value: formatDate(emp.employmentDate) },
          { icon: <Briefcase className="w-3.5 h-3.5" />, label: "Position:", value: emp.position ?? "—" },
          { icon: <MapPin className="w-3.5 h-3.5" />, label: "Location:", value: emp.location ?? "—" },
          { icon: <Users className="w-3.5 h-3.5" />, label: "Head of Department:", value: emp.headOfDepartment ?? "—" },
        ].map(({ icon, label, value }) => (
          <div key={label} className="flex items-start gap-2">
            <span className="text-muted-foreground shrink-0 mt-0.5">{icon}</span>
            <div className="flex flex-col min-w-0">
              <span className="font-poppins text-[10px] text-muted-foreground">{label}</span>
              <span className="font-poppins text-[11px] font-semibold text-foreground break-words">{value}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Main Export ──────────────────────────────────────────────────────────────

export default function EmployeeDocuments({
  employeeId,
  onBack,
}: {
  employeeId: string;
  onBack: () => void;
}) {
  const [filterBy, setFilterBy] = useState<"type" | "date" | "">("");
  const [searchDraft, setSearchDraft] = useState("");
  const [showUpload, setShowUpload] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  const {
    selectedDocEmployee,
    employeeDocuments,
    isLoadingEmployeeDocuments,
    documentsError,
    fetchEmployeeDocuments,
    deleteEmployeeDocument,
    downloadEmployeeDocument,
    clearSelectedDocEmployee,
  } = useHrmStore();

  useEffect(() => {
    fetchEmployeeDocuments(employeeId);
    return () => clearSelectedDocEmployee();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeId]);

  const handleFilter = () => {
    fetchEmployeeDocuments(employeeId, {
      search: searchDraft.trim() || undefined,
      filterBy: filterBy || undefined,
    });
  };

  const handlePreview = (doc: { url: string }) => {
    window.open(doc.url, "_blank", "noopener,noreferrer");
  };

  const handleDownload = async (docId: string) => {
    const { url, name } = await downloadEmployeeDocument(employeeId, docId);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  const handleDelete = async (docId: string) => {
    if (!confirm("Delete this document? This cannot be undone.")) return;
    await deleteEmployeeDocument(employeeId, docId);
  };

  if (isLoadingEmployeeDocuments && !selectedDocEmployee) {
    return (
      <div className="flex flex-col gap-4">
        <div className="h-[36px] w-[300px] bg-muted rounded animate-pulse" />
        <div className="flex flex-col md:flex-row gap-4">
          <div className="w-full md:w-[175px] h-[400px] bg-muted rounded-xl animate-pulse" />
          <div className="flex-1 h-[400px] bg-muted rounded-xl animate-pulse" />
        </div>
      </div>
    );
  }

  if (documentsError && !selectedDocEmployee) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16">
        <p className="font-poppins text-[13px] text-red-500">{documentsError}</p>
        <button
          onClick={() => fetchEmployeeDocuments(employeeId)}
          className="flex items-center gap-1.5 text-[12px] font-poppins text-primary hover:underline"
        >
          <RefreshCw className="w-3.5 h-3.5" /> Retry
        </button>
        <button onClick={onBack} className="text-[12px] font-poppins text-muted-foreground hover:underline">
          Go back
        </button>
      </div>
    );
  }

  if (!selectedDocEmployee) return null;
  const emp = selectedDocEmployee;

  return (
    <div className="flex flex-col gap-4">
      {/* Filter row */}
      <div className="flex items-center gap-3 flex-wrap">
        <button onClick={onBack} className="font-poppins text-[12px] text-muted-foreground hover:text-primary transition-colors shrink-0">
          ← Back
        </button>
        <div className="flex items-center gap-2">
          <span className="font-poppins text-[12px] text-foreground shrink-0">Filter By:</span>
          <select
            value={filterBy}
            onChange={(e) => setFilterBy(e.target.value as typeof filterBy)}
            className="text-[12px] font-poppins text-foreground bg-muted border border-border rounded-lg px-2.5 py-1.5 outline-none cursor-pointer h-[36px]"
          >
            {FILTER_OPTIONS.map((o) => (
              <option key={o.label} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2 bg-muted border border-border rounded-lg px-3 h-[36px] flex-1 min-w-[160px]">
          <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          <input
            type="text"
            placeholder="Search here..."
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleFilter()}
            className="bg-transparent text-[12px] font-poppins text-foreground outline-none w-full placeholder:text-muted-foreground"
          />
        </div>
        <button
          onClick={handleFilter}
          className="h-[36px] px-6 bg-primary text-white text-[12px] font-poppins font-semibold rounded-lg hover:bg-primary/90 transition-colors shrink-0"
        >
          Filter
        </button>
      </div>

      {/* Main layout */}
      <div className="flex flex-col md:flex-row gap-4 items-start">
        <LeftPanel emp={emp} />

        {/* Right: documents table */}
        <div className="flex-1 min-w-0 w-full bg-card rounded-xl border border-border overflow-hidden">
          <div className="flex items-center justify-between px-4 sm:px-5 py-4 border-b border-border">
            <div>
              <h3 className="font-poppins text-[13px] font-semibold text-foreground">Employee Documents</h3>
              <p className="font-poppins text-[11px] text-muted-foreground mt-0.5">
                This section contains all documents submitted by employee
              </p>
            </div>
            <button
              onClick={() => setShowUpload(true)}
              className="h-[36px] px-4 bg-primary text-white text-[12px] font-poppins font-semibold rounded-lg hover:bg-primary/90 transition-colors shrink-0"
            >
              Upload Document
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px]">
              <thead>
                <tr className="border-b border-border bg-muted/40">
                  {["Title", "Type", "Upload Date", "Expiry", "Uploaded By", "Action"].map((h) => (
                    <th key={h} className="text-left py-2.5 px-4 text-[11px] font-poppins font-semibold text-muted-foreground whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {isLoadingEmployeeDocuments ? (
                  Array.from({ length: 4 }).map((_, i) => (
                    <tr key={i} className="border-b border-border/50">
                      {Array.from({ length: 6 }).map((_, j) => (
                        <td key={j} className="py-3 px-4"><div className="h-4 bg-muted rounded animate-pulse w-full max-w-[100px]" /></td>
                      ))}
                    </tr>
                  ))
                ) : employeeDocuments.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-10 text-center">
                      <div className="flex flex-col items-center gap-2">
                        <FileText className="w-6 h-6 text-muted-foreground" />
                        <p className="font-poppins text-[12px] text-muted-foreground">No documents uploaded yet</p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  employeeDocuments.map((doc, i) => (
                    <tr
                      key={doc.id}
                      className={`border-b border-border/50 hover:bg-muted/20 transition-colors ${i % 2 === 0 ? "bg-muted/10" : ""}`}
                    >
                      <td className="py-3 px-4 font-poppins text-[12px] font-semibold text-foreground whitespace-nowrap">{doc.title}</td>
                      <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap uppercase">{doc.type}</td>
                      <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{formatDate(doc.uploadedAt)}</td>
                      <td className="py-3 px-4 font-poppins text-[12px] text-muted-foreground whitespace-nowrap">{formatDate(doc.expiryDate)}</td>
                      <td className="py-3 px-4 font-poppins text-[12px] text-muted-foreground whitespace-nowrap">{doc.uploadedBy ?? "—"}</td>
                      <td className="py-3 px-4">
                        <div className="relative">
                          <button
                            onClick={() => setOpenMenuId(openMenuId === doc.id ? null : doc.id)}
                            className="text-muted-foreground hover:text-foreground transition-colors"
                          >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                              <circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/>
                            </svg>
                          </button>
                          {openMenuId === doc.id && (
                            <ActionMenu
                              onClose={() => setOpenMenuId(null)}
                              onPreview={() => handlePreview(doc)}
                              onDownload={() => handleDownload(doc.id)}
                              onDelete={() => handleDelete(doc.id)}
                            />
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {showUpload && (
        <UploadDocumentModal
          employeeId={employeeId}
          onClose={() => setShowUpload(false)}
        />
      )}
    </div>
  );
}