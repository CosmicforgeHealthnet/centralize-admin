"use client";

import { useEffect, useState } from "react";
import { TrendingUp, Search } from "lucide-react";
import ApplicationList from "./ApplicationList";
import CreateJobForm from "./CreateJobForm";
import { useHrmStore } from "@/stores/hrm.store";
import { VacancyStatus } from "@/types/hrm.types";

function StatCardSkeleton() {
  return (
    <div className="bg-card rounded-xl border border-border p-5 shadow-[0px_1px_2px_rgba(16,24,40,0.05)] flex flex-col items-center gap-2 flex-1 animate-pulse">
      <div className="w-10 h-10 rounded-lg bg-muted" />
      <div className="h-4 w-20 bg-muted rounded" />
      <div className="h-8 w-16 bg-muted rounded" />
      <div className="flex items-center gap-1">
        <div className="h-3 w-3 bg-muted rounded-full" />
        <div className="h-3 w-16 bg-muted rounded" />
      </div>
    </div>
  );
}

function StatCard({ 
  label, 
  value, 
  change, 
  subtitle, 
  color, 
  icon,
  isLoading 
}: { 
  label: string;
  value: string | number;
  change: string;
  subtitle: string;
  color: string;
  icon: string;
  isLoading: boolean;
}) {
  return (
    <div className="bg-card rounded-xl border border-border p-5 shadow-[0px_1px_2px_rgba(16,24,40,0.05)] flex flex-col items-center gap-2 flex-1">
      <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${color}18` }}>
        {icon === "opening" ? (
          <svg className="w-5 h-5" style={{ color }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
            <circle cx="9" cy="7" r="4"/>
            <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>
          </svg>
        ) : (
          <svg className="w-5 h-5" style={{ color }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
        )}
      </div>
      <span className="font-poppins text-[12px] font-semibold" style={{ color }}>{label}</span>
      <span className="font-poppins text-[32px] font-bold text-foreground leading-none">
        {isLoading ? "..." : value}
      </span>
      <div className="flex items-center gap-1">
        <TrendingUp className="w-3 h-3 text-green-500 shrink-0" />
        <span className="font-poppins text-[10px] font-semibold text-green-500">{change}</span>
        <span className="font-poppins text-[10px] text-muted-foreground">{subtitle}</span>
      </div>
    </div>
  );
}

function VacancyRowSkeleton() {
  return (
    <tr className="border-b border-border/50 animate-pulse">
      <td className="py-3 px-4"><div className="h-4 w-20 bg-muted rounded" /></td>
      <td className="py-3 px-4"><div className="h-4 w-32 bg-muted rounded" /></td>
      <td className="py-3 px-4"><div className="h-4 w-24 bg-muted rounded" /></td>
      <td className="py-3 px-4"><div className="h-4 w-20 bg-muted rounded" /></td>
      <td className="py-3 px-4"><div className="h-4 w-16 bg-muted rounded" /></td>
      <td className="py-3 px-4"><div className="h-4 w-8 bg-muted rounded" /></td>
      <td className="py-3 px-4"><div className="h-4 w-12 bg-muted rounded" /></td>
      <td className="py-3 px-4"><div className="h-6 w-16 bg-muted rounded-full" /></td>
      <td className="py-3 px-4"><div className="h-4 w-4 bg-muted rounded-full" /></td>
    </tr>
  );
}

const STATUS_STYLES: Record<string, { bg: string; text: string }> = {
  "OPEN": { bg: "rgba(13,165,63,0.12)", text: "#0DA53F" },
  "IN_REVIEW": { bg: "rgba(232,182,0,0.12)", text: "#E8B600" },
  "CLOSED": { bg: "rgba(246,69,69,0.12)", text: "#F64545" },
};

const FILTER_OPTIONS: ("title" | "department" | "category")[] = ["title", "department", "category"];

export default function HiringPage() {
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [showCreateJob, setShowCreateJob] = useState(false);
  const [filterBy, setFilterBy] = useState<"title" | "department" | "category">("title");
  const [searchDraft, setSearchDraft] = useState("");

  const {
    hiringStats,
    isLoadingHiringStats,
    vacancies,
    vacanciesMeta,
    isLoadingVacancies,
    vacanciesFilters,
    hiringError,
    fetchHiringStats,
    fetchVacancies,
    setVacanciesFilters,
  } = useHrmStore();

  useEffect(() => {
    fetchHiringStats();
    fetchVacancies();
  }, []);

  const handleFilter = () => {
    setVacanciesFilters({ 
      search: searchDraft || undefined, 
      filterBy: filterBy,
      page: 1 
    });
  };

  const handleStatusFilter = (status: string) => {
    setVacanciesFilters({ 
      status: status === "All" ? undefined : status as VacancyStatus,
      page: 1 
    });
  };

  const handlePageChange = (page: number) => {
    setVacanciesFilters({ ...vacanciesFilters, page });
  };

  if (showCreateJob) {
    return <CreateJobForm onBack={() => setShowCreateJob(false)} />;
  }

  if (selectedJobId) {
    return (
      <ApplicationList
        jobId={selectedJobId}
        jobTitle={vacancies.find((j) => j.id === selectedJobId)?.title ?? ""}
        onBack={() => setSelectedJobId(null)}
      />
    );
  }

  const stats = hiringStats;
  const statCards = [
    { 
      label: "Number of Opening", 
      value: stats?.numberOfOpenings || 0, 
      change: `${stats?.changes?.openingsChange || 0}%`, 
      subtitle: "performance from last week", 
      color: "#272EA7", 
      icon: "opening" 
    },
    { 
      label: "Applications Received", 
      value: stats?.applicationsReceived || 0, 
      change: `${stats?.changes?.applicationsChange || 0}%`, 
      subtitle: "performance from last week", 
      color: "#0DA53F", 
      icon: "apps" 
    },
  ];

  const statusOptions = ["All", "OPEN", "IN_REVIEW", "CLOSED"];

  return (
    <div className="flex flex-col gap-5">
      {hiringError && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded-lg text-sm">
          {hiringError}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {isLoadingHiringStats ? (
          <>
            <StatCardSkeleton />
            <StatCardSkeleton />
          </>
        ) : (
          statCards.map((card) => (
            <StatCard
              key={card.label}
              label={card.label}
              value={card.value}
              change={card.change}
              subtitle={card.subtitle}
              color={card.color}
              icon={card.icon}
              isLoading={isLoadingHiringStats}
            />
          ))
        )}
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="font-poppins text-[12px] text-foreground shrink-0">Filter By:</span>
          <select
            value={filterBy}
            onChange={(e) => setFilterBy(e.target.value as "title" | "department" | "category")}
            className="text-[12px] font-poppins text-foreground bg-muted border border-border rounded-lg px-2.5 py-1.5 outline-none cursor-pointer h-[36px]"
          >
            {FILTER_OPTIONS.map((o) => <option key={o}>{o.charAt(0).toUpperCase() + o.slice(1)}</option>)}
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

      <div className="bg-card rounded-xl border border-border overflow-hidden">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-4 sm:px-5 py-4 border-b border-border">
          <div>
            <h3 className="font-poppins text-[13px] font-semibold text-foreground">Job Vacancies</h3>
            <p className="font-poppins text-[11px] text-muted-foreground">Job Vacancies and Hiring Management</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={vacanciesFilters.status || "All"}
              onChange={(e) => handleStatusFilter(e.target.value)}
              className="text-[11px] font-poppins text-muted-foreground bg-muted border border-border rounded-lg px-2.5 py-1.5 outline-none cursor-pointer h-[32px]"
            >
              {statusOptions.map((s) => <option key={s}>{s}</option>)}
            </select>
            <button
              onClick={() => setShowCreateJob(true)}
              className="h-[36px] px-4 bg-primary text-white text-[12px] font-poppins font-semibold rounded-lg hover:bg-primary/90 transition-colors shrink-0"
            >
              Create New Job
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[750px]">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                {["Date", "Job Title", "Department", "Category", "Location", "Opening", "Applicants", "Status", "Action"].map((h) => (
                  <th key={h} className="text-left py-2.5 px-4 text-[12px] font-poppins font-semibold text-muted-foreground whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {isLoadingVacancies ? (
                Array.from({ length: 5 }).map((_, i) => <VacancyRowSkeleton key={i} />)
              ) : vacancies.length > 0 ? (
                vacancies.map((job) => {
                  const st = STATUS_STYLES[job.status] || STATUS_STYLES["OPEN"];
                  const displayStatus = job.status.replace("_", " ");
                  return (
                    <tr
                      key={job.id}
                      className="border-b border-border/50 hover:bg-muted/20 transition-colors cursor-pointer"
                      onClick={() => setSelectedJobId(job.id)}
                    >
                      <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{job.createdAt}</td>
                      <td className="py-3 px-4 font-poppins text-[12px] font-semibold text-foreground whitespace-nowrap">{job.title}</td>
                      <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{job.department || "—"}</td>
                      <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{job.category || "—"}</td>
                      <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{job.location || "—"}</td>
                      <td className="py-3 px-4 font-poppins text-[12px] text-foreground">{job.numberOfOpening}</td>
                      <td className="py-3 px-4 font-poppins text-[12px] text-foreground">{job.applicantsCount}</td>
                      <td className="py-3 px-4">
                        <span
                          className="inline-flex items-center px-3 py-1 rounded-full text-[11px] font-poppins font-semibold whitespace-nowrap"
                          style={{ backgroundColor: st.bg, color: st.text }}
                        >
                          {displayStatus}
                        </span>
                      </td>
                      <td className="py-3 px-4" onClick={(e) => e.stopPropagation()}>
                        <button className="text-muted-foreground hover:text-foreground transition-colors">
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                            <circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/>
                          </svg>
                        </button>
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={9} className="text-center py-12 font-poppins text-[13px] text-muted-foreground">
                    No vacancies found
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {vacanciesMeta && vacanciesMeta.totalPages > 1 && (
          <div className="flex items-center justify-center gap-2 py-4 border-t border-border">
            <button
              onClick={() => handlePageChange(vacanciesMeta.page - 1)}
              disabled={vacanciesMeta.page <= 1}
              className="px-3 py-1 text-sm border border-border rounded-lg disabled:opacity-50 hover:bg-muted transition-colors"
            >
              Previous
            </button>
            <span className="text-sm text-muted-foreground">
              Page {vacanciesMeta.page} of {vacanciesMeta.totalPages}
            </span>
            <button
              onClick={() => handlePageChange(vacanciesMeta.page + 1)}
              disabled={vacanciesMeta.page >= vacanciesMeta.totalPages}
              className="px-3 py-1 text-sm border border-border rounded-lg disabled:opacity-50 hover:bg-muted transition-colors"
            >
              Next
            </button>
          </div>
        )}
      </div>
    </div>
  );
}