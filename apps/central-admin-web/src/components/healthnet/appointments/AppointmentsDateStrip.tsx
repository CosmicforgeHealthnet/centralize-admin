"use client";

import { useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useHealthnetStore } from "@/stores/healthnet.store";

// ─── Constants ────────────────────────────────────────────────────────────────

const MONTHS = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];
const YEARS = Array.from({ length: 10 }, (_, i) => 2022 + i);
const DAY_LABELS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const FILTER_OPTIONS = ["All","Morning","Afternoon","Evening","Emergency"];

// ─── Types ────────────────────────────────────────────────────────────────────

interface DateItem {
  date: number;
  day: string;
  fullDate: Date;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildDates(year: number, month: number): DateItem[] {
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  return Array.from({ length: daysInMonth }, (_, i) => {
    const d = new Date(year, month, i + 1);
    return { date: d.getDate(), day: DAY_LABELS[d.getDay()], fullDate: d };
  });
}

function isSameDay(a: Date, b: Date) {
  return (
    a.getDate() === b.getDate() &&
    a.getMonth() === b.getMonth() &&
    a.getFullYear() === b.getFullYear()
  );
}

function toYYYYMMDD(d: Date) {
  return d.toISOString().slice(0, 10);
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function AppointmentsDateStrip() {
  const today = new Date();
  const [selected, setSelected] = useState<Date>(today);
  const [month,    setMonth]    = useState(today.getMonth());
  const [year,     setYear]     = useState(today.getFullYear());
  const [filter,   setFilter]   = useState("All");
  const [filterOpen, setFilterOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const { fetchAppointments, clearSearch } = useHealthnetStore();

  const dates = buildDates(year, month);

  // Map filter label → status query param
  const filterToStatus: Record<string, string | undefined> = {
    All:       undefined,
    Morning:   "upcoming",  // could be extended with time-of-day logic
    Afternoon: "upcoming",
    Evening:   "upcoming",
    Emergency: "upcoming",
  };

  const loadAppointments = (date: Date, currentFilter: string) => {
    clearSearch();
    fetchAppointments({
      date:   toYYYYMMDD(date),
      status: filterToStatus[currentFilter],
    });
  };

  const handleSelect = (item: DateItem) => {
    setSelected(item.fullDate);
    loadAppointments(item.fullDate, filter);
  };

  const handleMonthChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const m = parseInt(e.target.value);
    setMonth(m);
    const maxDay = new Date(year, m + 1, 0).getDate();
    const newDate = new Date(year, m, Math.min(selected.getDate(), maxDay));
    setSelected(newDate);
    loadAppointments(newDate, filter);
    setTimeout(() => scrollToSelected(newDate, buildDates(year, m)), 50);
  };

  const handleYearChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const y = parseInt(e.target.value);
    setYear(y);
    const maxDay = new Date(y, month + 1, 0).getDate();
    const newDate = new Date(y, month, Math.min(selected.getDate(), maxDay));
    setSelected(newDate);
    loadAppointments(newDate, filter);
  };

  const handleFilterChange = (opt: string) => {
    setFilter(opt);
    setFilterOpen(false);
    loadAppointments(selected, opt);
  };

  const scrollToSelected = (date: Date, list: DateItem[]) => {
    const el = scrollRef.current;
    if (!el) return;
    const idx = list.findIndex((d) => isSameDay(d.fullDate, date));
    if (idx >= 0) el.scrollLeft = idx * 66;
  };

  const scroll = (dir: "left" | "right") => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ left: dir === "left" ? -(66 * 4) : 66 * 4, behavior: "smooth" });
  };

  return (
    <>
      <style>{`
        .ads-scroll::-webkit-scrollbar { display: none; }
        .ads-scroll { scrollbar-width: none; -ms-overflow-style: none; }
        .ads-select {
          appearance: none; -webkit-appearance: none;
          background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='11' height='11' viewBox='0 0 24 24' fill='none' stroke='%238F90A4' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");
          background-repeat: no-repeat; background-position: right 10px center;
          background-color: var(--card); border: 1px solid var(--border); border-radius: 8px;
          padding: 0 28px 0 12px; height: 36px; font-family: 'Poppins', sans-serif;
          font-size: 13px; font-weight: 500; color: var(--foreground); cursor: pointer; outline: none;
          transition: border-color 140ms ease, box-shadow 140ms ease;
        }
        .ads-select:hover { border-color: var(--muted-foreground); }
        .ads-select:focus { border-color: var(--primary); box-shadow: 0 0 0 3px rgba(39,46,167,0.08); }
        .ads-nav-btn {
          display: flex; align-items: center; justify-content: center;
          width: 30px; height: 52px; border-radius: 8px; border: 1px solid var(--border);
          background: var(--card); color: var(--muted-foreground); cursor: pointer; flex-shrink: 0;
          transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
        }
        .ads-nav-btn:hover { background: var(--accent); border-color: var(--primary); color: var(--primary); }
        .ads-nav-btn:active { transform: scale(0.95); }
        .ads-cell {
          display: flex; flex-direction: column; align-items: center; justify-content: center;
          gap: 4px; min-width: 60px; height: 52px; border-radius: 10px;
          border: 1px solid var(--border); background: var(--card); cursor: pointer; flex-shrink: 0;
          transition: border-color 130ms ease, background 130ms ease; user-select: none;
        }
        .ads-cell:hover:not(.ads-cell--active) { border-color: var(--muted-foreground); background: var(--muted); }
        .ads-cell--active { border: 1.5px solid var(--foreground) !important; background: var(--card); }
        .ads-cell__num { font-family: 'Poppins', sans-serif; font-size: 14px; font-weight: 700; line-height: 1; color: var(--foreground); }
        .ads-cell__day { font-family: 'Poppins', sans-serif; font-size: 11px; font-weight: 400; line-height: 1; color: var(--muted-foreground); }
        .ads-cell--active .ads-cell__day { color: var(--foreground); }
        .ads-filter-btn {
          display: flex; align-items: center; gap: 6px; padding: 0 12px 0 14px; height: 36px;
          border-radius: 8px; border: 1px solid var(--border); background: var(--card);
          font-family: 'Poppins', sans-serif; font-size: 13px; font-weight: 500; color: var(--foreground);
          cursor: pointer; white-space: nowrap; transition: border-color 140ms ease;
        }
        .ads-filter-btn:hover { border-color: var(--muted-foreground); }
        .ads-filter-menu {
          position: absolute; right: 0; top: calc(100% + 6px); min-width: 140px;
          background: var(--card); border: 1px solid var(--border); border-radius: 10px;
          box-shadow: 0 8px 24px rgba(0,0,0,0.09); padding: 4px; z-index: 200;
          animation: ads-pop 120ms ease;
        }
        @keyframes ads-pop {
          from { opacity: 0; transform: translateY(-6px) scale(0.98); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
        .ads-filter-opt {
          display: flex; align-items: center; width: 100%; padding: 8px 12px; border-radius: 7px;
          font-family: 'Poppins', sans-serif; font-size: 12.5px; font-weight: 400; color: var(--foreground);
          cursor: pointer; border: none; background: transparent; text-align: left; transition: background 100ms;
        }
        .ads-filter-opt:hover { background: var(--accent); }
        .ads-filter-opt--active { font-weight: 600; color: var(--primary); background: var(--secondary); }
      `}</style>

      <div style={{ display: "flex", flexDirection: "column", gap: "10px", width: "100%" }}>

        {/* Row 1: Month + Year | Filter */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <select className="ads-select" value={month} onChange={handleMonthChange} aria-label="Select month">
              {MONTHS.map((m, i) => <option key={m} value={i}>{m}</option>)}
            </select>
            <select className="ads-select" value={year} onChange={handleYearChange} aria-label="Select year" style={{ width: "82px" }}>
              {YEARS.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>

          <div style={{ position: "relative" }}>
            <button className="ads-filter-btn" onClick={() => setFilterOpen((o) => !o)}>
              {filter}
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            {filterOpen && (
              <>
                <div style={{ position: "fixed", inset: 0, zIndex: 199 }} onClick={() => setFilterOpen(false)} />
                <div className="ads-filter-menu">
                  {FILTER_OPTIONS.map((opt) => (
                    <button
                      key={opt}
                      className={`ads-filter-opt${filter === opt ? " ads-filter-opt--active" : ""}`}
                      onClick={() => handleFilterChange(opt)}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        {/* Row 2: Date strip */}
        <div style={{ display: "flex", alignItems: "center", gap: "6px", width: "100%" }}>
          <button className="ads-nav-btn" onClick={() => scroll("left")} aria-label="Scroll dates left">
            <ChevronLeft size={14} />
          </button>

          <div
            ref={scrollRef}
            className="ads-scroll"
            style={{ display: "flex", gap: "6px", overflowX: "auto", flex: 1, minWidth: 0, padding: "2px 0" }}
          >
            {dates.map((item, i) => {
              const isActive = isSameDay(item.fullDate, selected);
              return (
                <button
                  key={i}
                  className={`ads-cell${isActive ? " ads-cell--active" : ""}`}
                  onClick={() => handleSelect(item)}
                  aria-label={`${item.day} ${item.date}`}
                  aria-pressed={isActive}
                >
                  <span className="ads-cell__num">{item.date}</span>
                  <span className="ads-cell__day">{item.day}</span>
                </button>
              );
            })}
          </div>

          <button className="ads-nav-btn" onClick={() => scroll("right")} aria-label="Scroll dates right">
            <ChevronRight size={14} />
          </button>
        </div>
      </div>
    </>
  );
}