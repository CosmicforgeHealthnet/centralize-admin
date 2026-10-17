"use client";

import { useEffect } from "react";
import { ArrowLeft, FileText } from "lucide-react";
import { useHrmStore } from "@/stores/hrm.store";

function InfoCell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 p-3 rounded-xl border border-border bg-background">
      <span className="font-poppins text-[10px] text-muted-foreground">{label}</span>
      <div className="mt-0.5">{children}</div>
    </div>
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

const STAGE_STYLES: Record<string, { bg: string; text: string }> = {
  SCREENING: { bg: "rgba(13,165,63,0.12)", text: "#0DA53F" },
  INTERVIEW: { bg: "rgba(232,182,0,0.12)", text: "#E8B600" },
  HIRED: { bg: "rgba(39,46,167,0.10)", text: "#272EA7" },
  REJECTED: { bg: "rgba(246,69,69,0.12)", text: "#F64545" },
};

export default function ApplicantReview({
  applicantId,
  onBack,
}: {
  applicantId: string;
  onBack: () => void;
}) {
  const {
    selectedApplicant,
    isLoadingApplicant,
    hiringError,
    fetchApplicant,
    clearSelectedApplicant,
  } = useHrmStore();

  useEffect(() => {
    fetchApplicant(applicantId);
    return () => clearSelectedApplicant();
  }, [applicantId]);

  const app = selectedApplicant;

  if (isLoadingApplicant) {
    return (
      <div className="flex flex-col gap-4">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-muted-foreground hover:text-primary transition-colors w-fit"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span className="font-poppins text-[12px] font-medium">Go Back</span>
        </button>
        <div className="bg-card rounded-xl border border-border p-4 sm:p-6 flex flex-col gap-5 animate-pulse">
          <div className="h-6 w-40 bg-muted rounded" />
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex flex-col gap-1">
                <div className="h-3 w-16 bg-muted rounded" />
                <div className="h-4 w-24 bg-muted rounded" />
              </div>
            ))}
          </div>
          <div className="h-32 bg-muted rounded" />
        </div>
      </div>
    );
  }

  if (!app) {
    return (
      <div className="flex flex-col gap-4">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-muted-foreground hover:text-primary transition-colors w-fit"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span className="font-poppins text-[12px] font-medium">Go Back</span>
        </button>
        <div className="bg-card rounded-xl border border-border p-4 sm:p-6 text-center">
          <p className="font-poppins text-[13px] text-muted-foreground">Applicant not found</p>
        </div>
      </div>
    );
  }

  const st = STAGE_STYLES[app.stage] || STAGE_STYLES["SCREENING"];
  const displayStage = app.stage.charAt(0) + app.stage.slice(1).toLowerCase();

  return (
    <div className="flex flex-col gap-4">
      {hiringError && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded-lg text-sm">
          {hiringError}
        </div>
      )}

      <button
        onClick={onBack}
        className="flex items-center gap-1.5 text-muted-foreground hover:text-primary transition-colors w-fit"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        <span className="font-poppins text-[12px] font-medium">Go Back</span>
      </button>

      <div className="bg-card rounded-xl border border-border p-4 sm:p-6 flex flex-col gap-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-poppins text-[15px] font-semibold text-foreground">Applicant Details</h2>
          <button className="text-muted-foreground hover:text-foreground transition-colors">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/>
            </svg>
          </button>
        </div>

        <div className="rounded-xl border border-border p-4 bg-card">
          <h3 className="font-poppins text-[13px] font-semibold text-foreground mb-3">Applicant Bio-Data</h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: "Full Name:", value: app.fullName },
              { label: "Email:", value: app.email || "—" },
              { label: "Phone Number:", value: app.phone || "—" },
              { label: "Country:", value: app.country || "—" },
            ].map(({ label, value }) => (
              <div key={label} className="flex flex-col gap-0.5">
                <span className="font-poppins text-[10px] text-muted-foreground">{label}</span>
                <span className="font-poppins text-[12px] font-semibold text-foreground">{value}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <InfoCell label="Application Status">
            <span
              className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-poppins font-semibold"
              style={{ backgroundColor: st.bg, color: st.text }}
            >
              {displayStage}
            </span>
          </InfoCell>
          <InfoCell label="Category">
            <span className="font-poppins text-[12px] font-semibold text-foreground">
              {app.vacancy?.category || "—"}
            </span>
          </InfoCell>
          <InfoCell label="Location">
            <span className="font-poppins text-[12px] font-semibold text-foreground">
              {app.vacancy?.location || "—"}
            </span>
          </InfoCell>
          <InfoCell label="Via">
            <GmailBadge />
          </InfoCell>
          <InfoCell label="Application Date">
            <span className="font-poppins text-[12px] font-semibold text-foreground">
              {app.applicationDate}
            </span>
          </InfoCell>
        </div>

        {app.coverLetter && (
          <div className="rounded-xl border border-border p-4 bg-background">
            <p className="font-poppins text-[12px] text-foreground leading-relaxed whitespace-pre-line">
              {app.coverLetter}
            </p>
          </div>
        )}

        {app.attachments && app.attachments.length > 0 && (
          <div className="flex flex-col gap-3">
            <h3 className="font-poppins text-[13px] font-semibold text-foreground">Attachment</h3>
            <div className="flex flex-wrap gap-3">
              {app.attachments.map((att) => (
                <div
                  key={att.id}
                  className="flex items-center gap-3 bg-muted rounded-xl border border-border px-4 py-3 cursor-pointer hover:border-primary/30 transition-colors"
                >
                  <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                    <FileText className="w-4 h-4 text-primary" />
                  </div>
                  <div className="flex flex-col">
                    <span className="font-poppins text-[12px] font-semibold text-foreground">{att.name || "Attachment"}</span>
                    <span className="font-poppins text-[10px] text-muted-foreground">{att.type || "File"}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}