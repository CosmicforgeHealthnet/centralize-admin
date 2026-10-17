"use client";

import React, { useState } from "react";
import { Search, ChevronDown } from "lucide-react";
import { useHealthnetStore } from "@/stores/healthnet.store";

const DEPARTMENTS = [
  "All Departments", "General Medicine", "Obstetrics & Gynecology",
  "Neonatology", "Emergency Medicine", "Cardiology", "Neurology",
  "Pediatrics", "Orthopedics",
];
const CATEGORIES = [
  "All Categories", "Consultation", "Follow-up",
  "Emergency", "Routine Check", "Surgery", "Lab Work",
];

function FilterDropdown({
  value, options, onChange,
}: {
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((p) => !p)}
        className="flex items-center gap-1.5 px-3 py-2 rounded-[8px] border border-border bg-card text-[13px] font-poppins text-foreground hover:bg-muted transition-colors whitespace-nowrap"
      >
        {value}
        <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground transition-transform duration-150 ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute top-full right-0 mt-1 z-20 bg-card border border-border rounded-xl shadow-xl py-1 min-w-[180px] max-h-[220px] overflow-y-auto">
            {options.map((o) => (
              <button
                key={o}
                onClick={() => { onChange(o); setOpen(false); }}
                className={`w-full text-left px-3 py-1.5 text-[12px] font-poppins transition-colors hover:bg-muted ${
                  o === value ? "text-primary font-semibold" : "text-muted-foreground"
                }`}
              >
                {o}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default function AppointmentsSearchBar() {
  const [query, setQuery]           = useState("");
  const [department, setDepartment] = useState("All Departments");
  const [category, setCategory]     = useState("All Categories");

  const { searchAppointments, fetchAppointments, clearSearch, searchLoading } =
    useHealthnetStore();

  const handleSearch = () => {
    const q = query.trim();
    if (!q) {
      // Empty search — clear results and reload plain appointments
      clearSearch();
      fetchAppointments();
      return;
    }
    searchAppointments({
      q,
      department: department === "All Departments" ? undefined : department,
      category:   category   === "All Categories"  ? undefined : category,
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") handleSearch();
  };

  const handleClear = () => {
    setQuery("");
    clearSearch();
    fetchAppointments();
  };

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {/* Search input */}
      <div className="flex-1 min-w-[200px] flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (!e.target.value.trim()) handleClear();
            }}
            onKeyDown={handleKeyDown}
            placeholder="Search patient, doctor, department..."
            className="w-full pl-9 pr-4 py-2 rounded-[8px] border border-border bg-card text-[13px] font-poppins text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all"
          />
        </div>
        <button
          onClick={handleSearch}
          disabled={searchLoading}
          className="px-4 py-2 rounded-[8px] bg-primary text-primary-foreground text-[13px] font-poppins font-semibold hover:bg-primary/90 transition-colors shrink-0 disabled:opacity-60"
        >
          {searchLoading ? "Searching..." : "Search"}
        </button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2">
        <FilterDropdown value={department} options={DEPARTMENTS} onChange={setDepartment} />
        <FilterDropdown value={category}   options={CATEGORIES}  onChange={setCategory}   />
      </div>
    </div>
  );
}