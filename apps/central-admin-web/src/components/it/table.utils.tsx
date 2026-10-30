"use client";

import { Search, ChevronLeft, ChevronRight } from "lucide-react";

export function SkeletonRow({ cols }: { cols: number }) {
  return (
    <tr className="border-b border-border/50">
      {Array.from({ length: cols }).map((_, i) => (
        <td key={i} className="py-3 px-4 sm:px-5">
          <div className="h-4 bg-muted rounded animate-pulse w-full max-w-[120px]" />
        </td>
      ))}
    </tr>
  );
}

export const STATUS_STYLES: Record<string, { bg: string; text: string }> = {
  pending:              { bg: "rgba(232,182,0,0.12)",   text: "#E8B600" },
  scheduled:            { bg: "rgba(39,46,167,0.10)",   text: "#272EA7" },
  ongoing:              { bg: "rgba(39,46,167,0.10)",   text: "#272EA7" },
  active:               { bg: "rgba(13,165,63,0.12)",   text: "#0DA53F" },
  completed:            { bg: "rgba(13,165,63,0.12)",   text: "#0DA53F" },
  cancelled:            { bg: "rgba(246,69,69,0.12)",   text: "#F64545" },
  failed:               { bg: "rgba(246,69,69,0.12)",   text: "#F64545" },
  disputed:             { bg: "rgba(246,69,69,0.12)",   text: "#F64545" },
  refunded:             { bg: "rgba(143,144,164,0.15)", text: "#8F90A4" },
  processing:           { bg: "rgba(39,46,167,0.10)",   text: "#272EA7" },
  pharmacy_assigned:    { bg: "rgba(39,46,167,0.10)",   text: "#272EA7" },
  pharmacy_processing:  { bg: "rgba(232,182,0,0.12)",   text: "#E8B600" },
  ready_for_pickup:     { bg: "rgba(13,165,63,0.12)",   text: "#0DA53F" },
  ready_for_delivery:   { bg: "rgba(13,165,63,0.12)",   text: "#0DA53F" },
  patient_uploaded:     { bg: "rgba(232,182,0,0.12)",   text: "#E8B600" },
};

export function StatusBadge({ status }: { status: string }) {
  const style = STATUS_STYLES[status] ?? { bg: "rgba(143,144,164,0.15)", text: "#8F90A4" };
  return (
    <span
      className="inline-flex items-center px-3 py-1 rounded-full text-[12px] font-poppins font-semibold whitespace-nowrap capitalize"
      style={{ backgroundColor: style.bg, color: style.text }}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}

export function TableSearch({
  value,
  onChange,
  onSearch,
  placeholder = "Search here...",
}: {
  value: string;
  onChange: (v: string) => void;
  onSearch: () => void;
  placeholder?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-2 bg-muted border border-border rounded-lg px-3 h-[36px] flex-1 sm:w-[200px] sm:flex-none">
        <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        <input
          type="text"
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onSearch()}
          className="bg-transparent text-[12px] font-poppins text-foreground outline-none w-full placeholder:text-muted-foreground"
        />
      </div>
      <button
        onClick={onSearch}
        className="h-[36px] px-5 bg-primary text-white text-[13px] font-poppins font-semibold rounded-lg hover:bg-primary/90 transition-colors shrink-0"
      >
        Search
      </button>
    </div>
  );
}

export function TablePagination({
  currentPage,
  totalPages,
  onPageChange,
}: {
  currentPage: number;
  totalPages: number;
  onPageChange: (p: number) => void;
}) {
  if (totalPages <= 1) return null;

  const pageNumbers = (): (number | "...")[] => {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
    const pages: (number | "...")[] = [1, 2, 3];
    if (currentPage > 4) pages.push("...");
    if (currentPage > 3 && currentPage < totalPages - 2) pages.push(currentPage);
    if (currentPage < totalPages - 3) pages.push("...");
    pages.push(totalPages - 1, totalPages);
    return [...new Set(pages)];
  };

  return (
    <div className="flex items-center justify-end gap-1 px-4 sm:px-5 py-4 flex-wrap">
      <button
        onClick={() => onPageChange(currentPage - 1)}
        disabled={currentPage === 1}
        className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
      >
        <ChevronLeft className="w-4 h-4 text-foreground" />
      </button>
      {pageNumbers().map((p, i) =>
        p === "..." ? (
          <span key={`el-${i}`} className="w-7 h-7 flex items-center justify-center text-[12px] font-poppins text-muted-foreground">...</span>
        ) : (
          <button
            key={p}
            onClick={() => onPageChange(p as number)}
            className={`w-7 h-7 flex items-center justify-center rounded-md text-[12px] font-poppins font-semibold transition-colors ${
              currentPage === p ? "bg-primary text-white" : "text-foreground hover:bg-muted"
            }`}
          >
            {p}
          </button>
        )
      )}
      <button
        onClick={() => onPageChange(currentPage + 1)}
        disabled={currentPage === totalPages}
        className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
      >
        <ChevronRight className="w-4 h-4 text-foreground" />
      </button>
    </div>
  );
}

export function ErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="mx-4 mb-3 px-4 py-2.5 rounded-lg bg-red-50 border border-red-200 flex items-center justify-between">
      <span className="text-[12px] font-poppins text-red-600">{message}</span>
      <button onClick={onDismiss} className="text-[11px] font-poppins text-red-400 hover:text-red-600 ml-4">
        Dismiss
      </button>
    </div>
  );
}

export function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function truncateId(id: string) {
  return `${id.slice(0, 8)}...`;
}