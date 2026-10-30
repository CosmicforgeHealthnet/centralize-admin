"use client";

import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import EmployeeGrid from "./EmployeeGrid";
import EmployeeTable from "./EmployeeTable";
import EmployeeProfileDetail from "./EmployeeProfileDetail";
import { useHrmStore } from "@/stores/hrm.store";

// ─── View Toggle Icons ────────────────────────────────────────────────────────

function GridIcon({ active }: { active: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="1" y="1" width="6" height="6" rx="1" fill={active ? "#272EA7" : "currentColor"} fillOpacity={active ? 1 : 0.4} />
      <rect x="11" y="1" width="6" height="6" rx="1" fill={active ? "#272EA7" : "currentColor"} fillOpacity={active ? 1 : 0.4} />
      <rect x="1" y="11" width="6" height="6" rx="1" fill={active ? "#272EA7" : "currentColor"} fillOpacity={active ? 1 : 0.4} />
      <rect x="11" y="11" width="6" height="6" rx="1" fill={active ? "#272EA7" : "currentColor"} fillOpacity={active ? 1 : 0.4} />
    </svg>
  );
}

function ListIcon({ active }: { active: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="1" y="2" width="16" height="2.5" rx="1" fill={active ? "#272EA7" : "currentColor"} fillOpacity={active ? 1 : 0.4} />
      <rect x="1" y="7.5" width="16" height="2.5" rx="1" fill={active ? "#272EA7" : "currentColor"} fillOpacity={active ? 1 : 0.4} />
      <rect x="1" y="13" width="16" height="2.5" rx="1" fill={active ? "#272EA7" : "currentColor"} fillOpacity={active ? 1 : 0.4} />
    </svg>
  );
}

// ─── Main Export ──────────────────────────────────────────────────────────────

export default function AllEmployeesPage() {
  const [view,             setView]             = useState<"grid" | "table">("grid");
  const [selectedEmployee, setSelectedEmployee] = useState<string | null>(null);
  const [search,           setSearch]           = useState("");
  const [searchDraft,      setSearchDraft]      = useState("");

  const { employees, isLoadingList, error, fetchEmployees } = useHrmStore();

  useEffect(() => {
    fetchEmployees(search ? { search } : undefined);
  }, [search, fetchEmployees]);

  // If an employee is selected, show their profile detail
  if (selectedEmployee) {
    return (
      <EmployeeProfileDetail
        employeeId={selectedEmployee}
        onBack={() => setSelectedEmployee(null)}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <h2 className="font-poppins text-[15px] font-semibold text-foreground">
          All Employees
        </h2>

        <div className="flex items-center gap-2">
          {/* Search */}
          <div className="flex items-center gap-2 bg-muted border border-border rounded-lg px-3 h-[36px] flex-1 sm:w-[200px] sm:flex-none">
            <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <input
              type="text"
              placeholder="Search here..."
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") setSearch(searchDraft);
              }}
              className="bg-transparent text-[12px] font-poppins text-foreground outline-none w-full placeholder:text-muted-foreground"
            />
          </div>

          {/* View toggle */}
          <div className="flex items-center gap-1 bg-muted border border-border rounded-lg p-1 shrink-0">
            <button
              onClick={() => setView("table")}
              className={`w-7 h-7 flex items-center justify-center rounded-md transition-colors ${
                view === "table" ? "bg-card shadow-sm" : "hover:bg-card/60"
              }`}
              title="Table view"
            >
              <ListIcon active={view === "table"} />
            </button>
            <button
              onClick={() => setView("grid")}
              className={`w-7 h-7 flex items-center justify-center rounded-md transition-colors ${
                view === "grid" ? "bg-card shadow-sm" : "hover:bg-card/60"
              }`}
              title="Grid view"
            >
              <GridIcon active={view === "grid"} />
            </button>
          </div>
        </div>
      </div>

      {/* Error */}
      {error && (
        <p className="font-poppins text-[12px] text-red-500">{error}</p>
      )}

      {/* Content */}
      {view === "grid" ? (
        <EmployeeGrid
          employees={employees}
          isLoading={isLoadingList}
          onSelect={(id) => setSelectedEmployee(id)}
        />
      ) : (
        <EmployeeTable
          employees={employees}
          isLoading={isLoadingList}
          onSelect={(id) => setSelectedEmployee(id)}
        />
      )}
    </div>
  );
}