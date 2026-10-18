"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, Search } from "lucide-react";
import ApplicantReview from "./ApplicantReview";
import { useHrmStore } from "@/stores/hrm.store";
import { ApplicantStage } from "@/types/hrm.types";

function ApplicantRowSkeleton() {
  return (
    <tr className="border-b border-border/50 animate-pulse">
      <td className="py-3 px-4"><div className="h-4 w-20 bg-muted rounded" /></td>
      <td className="py-3 px-4"><div className="h-6 w-16 bg-muted rounded" /></td>
      <td className="py-3 px-4"><div className="h-4 w-32 bg-muted rounded" /></td>
      <td className="py-3 px-4"><div className="h-4 w-28 bg-muted rounded" /></td>
      <td className="py-3 px-4"><div className="h-4 w-24 bg-muted rounded" /></td>
      <td className="py-3 px-4"><div className="h-4 w-20 bg-muted rounded" /></td>
      <td className="py-3 px-4"><div className="h-6 w-20 bg-muted rounded-full" /></td>
      <td className="py-3 px-4"><div className="h-4 w-4 bg-muted rounded-full" /></td>
    </tr>
  );
}

function GmailBadge() {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-muted border border-border text-[11px] font-poppins font-semibold text-foreground">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
        <path d="M22 6C22 4.9 21.1 4 20 4H4C2.9 4 2 4.9 2 6V18C2 19.1 2.9 20 4 20H20C21.1 20 22 19.1 22 18V6Z" fill="#EA4335"/>
        <path d="M22 6L12 13L2 6" stroke="white" strokeWidth="2"/>
      </svg>
      Gmail
    </span>
  );
}

const STAGE_OPTIONS: (ApplicantStage | "All")[] = ["All", "SCREENING", "INTERVIEW", "HIRED", "REJECTED"];

const STAGE_STYLES: Record<string, { bg: string; text: string }> = {
  SCREENING: { bg: "rgba(13,165,63,0.12)", text: "#0DA53F" },
  INTERVIEW: { bg: "rgba(232,182,0,0.12)", text: "#E8B600" },
  HIRED: { bg: "rgba(39,46,167,0.10)", text: "#272EA7" },
  REJECTED: { bg: "rgba(246,69,69,0.12)", text: "#F64545" },
};

export default function ApplicationList({
  jobId,
  jobTitle,
  onBack,
}: {
  jobId: string;
  jobTitle: string;
  onBack: () => void;
}) {
  const [searchDraft, setSearchDraft] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const {
    applicants,
    applicantsMeta,
    isLoadingApplicants,
    applicantsFilters,
    hiringError,
    fetchApplicants,
    setApplicantsFilters,
    clearApplicants,
  } = useHrmStore();

  useEffect(() => {
    fetchApplicants(jobId);
    return () => clearApplicants();
  }, [jobId]);

  const handleFilter = () => {
    setApplicantsFilters({ 
      search: searchDraft || undefined,
      page: 1 
    });
  };

  const handleStageFilter = (stage: string) => {
    if (stage === "All") {
      setApplicantsFilters({ 
        stage: undefined,
        page: 1 
      });
    } else {
      setApplicantsFilters({ 
        stage: stage as ApplicantStage,
        page: 1 
      });
    }
  };

  const handlePageChange = (page: number) => {
    setApplicantsFilters({ ...applicantsFilters, page });
  };

  if (selectedId) {
    return (
      <ApplicantReview
        applicantId={selectedId}
        onBack={() => setSelectedId(null)}
      />
    );
  }

  const displayStage = (stage: string) => {
    return stage.charAt(0) + stage.slice(1).toLowerCase();
  };

  return (
    <div className="flex flex-col gap-4">
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 text-muted-foreground hover:text-primary transition-colors w-fit"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        <span className="font-poppins text-[12px] font-medium">Go Back</span>
      </button>

      <div className="bg-card rounded-xl border border-border overflow-hidden">
        <div className="px-4 sm:px-5 pt-4 pb-3 border-b border-border">
          <h3 className="font-poppins text-[14px] font-semibold text-foreground">
            {jobTitle} Applications
          </h3>
          <p className="font-poppins text-[11px] text-muted-foreground mt-0.5">
            Review your applicant received emails here.
          </p>

          {hiringError && (
            <div className="mt-2 bg-red-50 border border-red-200 text-red-700 px-3 py-1.5 rounded-lg text-sm">
              {hiringError}
            </div>
          )}

          <div className="flex items-center gap-3 flex-wrap mt-3">
            <div className="flex items-center gap-2">
              <span className="font-poppins text-[12px] text-foreground shrink-0">Filter By:</span>
              <select
                value={applicantsFilters.stage || "All"}
                onChange={(e) => handleStageFilter(e.target.value)}
                className="text-[12px] font-poppins text-foreground bg-muted border border-border rounded-lg px-2.5 py-1.5 outline-none cursor-pointer h-[36px]"
              >
                {STAGE_OPTIONS.map((o) => (
                  <option key={o} value={o}>{o}</option>
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
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[750px]">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                {["Date", "Via", "Name", "Email", "Phone Number", "Country", "Status", "Action"].map((h) => (
                  <th key={h} className="text-left py-2.5 px-4 text-[12px] font-poppins font-semibold text-muted-foreground whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {isLoadingApplicants ? (
                Array.from({ length: 5 }).map((_, i) => <ApplicantRowSkeleton key={i} />)
              ) : applicants.length === 0 ? (
                <tr>
                  <td colSpan={8} className="text-center py-12 font-poppins text-[13px] text-muted-foreground">
                    No applicants found
                  </td>
                </tr>
              ) : (
                applicants.map((app) => {
                  const st = STAGE_STYLES[app.stage] || STAGE_STYLES["SCREENING"];
                  return (
                    <tr
                      key={app.id}
                      className="border-b border-border/50 hover:bg-muted/20 transition-colors cursor-pointer"
                      onClick={() => setSelectedId(app.id)}
                    >
                      <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{app.applicationDate}</td>
                      <td className="py-3 px-4"><GmailBadge /></td>
                      <td className="py-3 px-4 font-poppins text-[12px] font-semibold text-foreground whitespace-nowrap">{app.fullName}</td>
                      <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{app.email || "—"}</td>
                      <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{app.phone || "—"}</td>
                      <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{app.country || "—"}</td>
                      <td className="py-3 px-4">
                        <span
                          className="inline-flex items-center px-3 py-1 rounded-full text-[11px] font-poppins font-semibold whitespace-nowrap"
                          style={{ backgroundColor: st.bg, color: st.text }}
                        >
                          {displayStage(app.stage)}
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
              )}
            </tbody>
          </table>
        </div>

        {applicantsMeta && applicantsMeta.totalPages > 1 && (
          <div className="flex items-center justify-center gap-2 py-4 border-t border-border">
            <button
              onClick={() => handlePageChange(applicantsMeta.page - 1)}
              disabled={applicantsMeta.page <= 1}
              className="px-3 py-1 text-sm border border-border rounded-lg disabled:opacity-50 hover:bg-muted transition-colors"
            >
              Previous
            </button>
            <span className="text-sm text-muted-foreground">
              Page {applicantsMeta.page} of {applicantsMeta.totalPages}
            </span>
            <button
              onClick={() => handlePageChange(applicantsMeta.page + 1)}
              disabled={applicantsMeta.page >= applicantsMeta.totalPages}
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