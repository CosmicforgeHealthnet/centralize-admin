"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { Search, Users, RefreshCw, ChevronLeft, ChevronRight } from "lucide-react";
import EmployeeDocuments from "./EmployeeDocuments";
import { useHrmStore } from "@/stores/hrm.store";
import { formatEnumLabel } from "@/types/hrm.types";

const FILTER_OPTIONS: { label: string; value: "name" | "department" | "designation" }[] = [
  { label: "Name", value: "name" },
  { label: "Department", value: "department" },
  { label: "Designation", value: "designation" },
];

function EmployeeCardSkeleton() {
  return <div className="bg-card border border-border rounded-xl p-4 h-[140px] animate-pulse" />;
}

function EmployeeCard({
  emp,
  onClick,
}: {
  emp: { id: string; name: string; designation: string | null; department: string | null; avatarUrl: string | null };
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="bg-card border border-border rounded-xl p-4 flex flex-col items-center gap-2 hover:shadow-md hover:border-primary/30 transition-all duration-200 text-center w-full"
    >
      <div className="w-16 h-16 rounded-full overflow-hidden bg-muted shrink-0">
        {emp.avatarUrl ? (
          <Image src={emp.avatarUrl} alt={emp.name} width={64} height={64} className="object-cover w-full h-full" />
        ) : (
          <div className="w-full h-full bg-primary/10 flex items-center justify-center">
            <span className="text-[20px] font-poppins font-bold text-primary">{emp.name.charAt(0)}</span>
          </div>
        )}
      </div>
      <div className="flex flex-col items-center min-w-0 w-full">
        <span className="font-poppins text-[13px] font-semibold text-foreground truncate w-full">{emp.name}</span>
        <span className="font-poppins text-[11px] font-semibold text-primary truncate w-full">{emp.designation ?? "—"}</span>
        <span className="font-poppins text-[11px] text-muted-foreground truncate w-full">{formatEnumLabel(emp.department)}</span>
      </div>
    </button>
  );
}

export default function DocumentsPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filterBy, setFilterBy] = useState<(typeof FILTER_OPTIONS)[number]["value"]>("name");
  const [searchDraft, setSearchDraft] = useState("");

  const {
    documentEmployees,
    documentEmployeesMeta,
    isLoadingDocumentEmployees,
    documentsError,
    documentEmployeesFilters,
    fetchDocumentEmployees,
    setDocumentEmployeesFilters,
    setDocumentEmployeesPage,
  } = useHrmStore();

  useEffect(() => {
    fetchDocumentEmployees();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFilter = () => {
    setDocumentEmployeesFilters({ search: searchDraft.trim() || undefined, filterBy });
  };

  const page = documentEmployeesMeta?.page ?? documentEmployeesFilters.page;
  const totalPages = documentEmployeesMeta?.totalPages ?? 1;

  if (selectedId) {
    return <EmployeeDocuments employeeId={selectedId} onBack={() => setSelectedId(null)} />;
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Filter row */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="font-poppins text-[12px] text-foreground shrink-0">Filter By:</span>
          <select
            value={filterBy}
            onChange={(e) => setFilterBy(e.target.value as typeof filterBy)}
            className="text-[12px] font-poppins text-foreground bg-muted border border-border rounded-lg px-2.5 py-1.5 outline-none cursor-pointer h-[36px]"
          >
            {FILTER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
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

      {/* Employee Grid */}
      {isLoadingDocumentEmployees ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
          {Array.from({ length: 10 }).map((_, i) => <EmployeeCardSkeleton key={i} />)}
        </div>
      ) : documentsError ? (
        <div className="flex flex-col items-center gap-2 py-16">
          <p className="font-poppins text-[12px] text-red-500">{documentsError}</p>
          <button
            onClick={() => fetchDocumentEmployees()}
            className="flex items-center gap-1.5 text-[12px] font-poppins text-primary hover:underline"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Retry
          </button>
        </div>
      ) : documentEmployees.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-16">
          <Users className="w-6 h-6 text-muted-foreground" />
          <p className="font-poppins text-[12px] text-muted-foreground">No employees found</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
          {documentEmployees.map((emp) => (
            <EmployeeCard
              key={emp.id}
              emp={emp}
              onClick={() => setSelectedId(emp.id)}
            />
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-end gap-1 py-2 flex-wrap">
          <button
            onClick={() => setDocumentEmployeesPage(Math.max(1, page - 1))}
            disabled={page === 1}
            className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronLeft className="w-4 h-4 text-foreground" />
          </button>
          {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
            <button
              key={p}
              onClick={() => setDocumentEmployeesPage(p)}
              className={`w-7 h-7 flex items-center justify-center rounded-md text-[12px] font-poppins font-semibold transition-colors ${
                page === p ? "bg-primary text-white" : "text-foreground hover:bg-muted"
              }`}
            >
              {p}
            </button>
          ))}
          <button
            onClick={() => setDocumentEmployeesPage(Math.min(totalPages, page + 1))}
            disabled={page === totalPages}
            className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronRight className="w-4 h-4 text-foreground" />
          </button>
        </div>
      )}
    </div>
  );
}