"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import {
  CreditCard, Phone, Mail, Briefcase, CalendarClock,
  Calendar, EyeOff, Download, ArrowLeft,
  ChevronDown, ChevronUp, Loader2, User, Clock,
  FileText, CheckCircle, XCircle, AlertCircle,
  Building, MapPin, UserPlus
} from "lucide-react";
import { useVerificationStore } from "@/stores/verification.store";
import type {
  VerificationDetail as TVerificationDetail,
  PharmacyVerificationDetail,
  LabVerificationDetail,
  DispatchVerificationDetail,
  VerificationRole,
  VerificationStatus,
} from "@/types/verification.types";
import DispatchDetail from "./DispatchDetail";
import api from "@/lib/api";
import { readHttpErrorMessage } from "@/lib/error-messages";


// ─── Types ────────────────────────────────────────────────────────────────────

type TabId = "overview" | "documents" | "history";

// ─── Constants ────────────────────────────────────────────────────────────────

const STATUS_STYLES: Record<string, { color: string; bg: string; darkBg: string }> = {
  Approved: { color: "#0DA53F", bg: "#F0FDF4",  darkBg: "rgba(13,165,63,0.15)"  },
  Pending:  { color: "#E8B600", bg: "#FEFCE8",  darkBg: "rgba(232,182,0,0.15)"  },
  Failed:   { color: "#F64545", bg: "#FFF1F1",  darkBg: "rgba(246,69,69,0.15)"  },
  Stuck:    { color: "#F59E0B", bg: "#FFFBEB",  darkBg: "rgba(245,158,11,0.15)" },
};

// ─── Date Formatter ───────────────────────────────────────────────────────────

function formatDate(value?: string | number | null, includeTime = false) {
  if (!value) return "—";
  const d = new Date(value);
  if (isNaN(d.getTime())) return String(value);
  if (includeTime) {
    const date = d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
    const time = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true });
    return `${date}, ${time}`;
  }
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

// ─── Primitives ───────────────────────────────────────────────────────────────

function InfoRow({ label, value }: { label: string; value?: string | number | null }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-poppins text-[10px] text-muted-foreground">{label}</span>
      <span className="font-poppins text-[11px] font-semibold text-foreground break-words">
        {value ?? "—"}
      </span>
    </div>
  );
}

function ContactRow({ icon, label, value }: { icon: React.ReactNode; label: string; value?: string | null }) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-muted-foreground shrink-0 mt-0.5">{icon}</span>
      <div className="flex flex-col min-w-0">
        <span className="font-poppins text-[10px] text-muted-foreground leading-tight">{label}</span>
        <span className="font-poppins text-[11px] font-semibold text-foreground leading-snug break-all">
          {value ?? "—"}
        </span>
      </div>
    </div>
  );
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border p-3 bg-card">
      <h3 className="font-poppins text-[12px] font-semibold text-foreground mb-3">{title}</h3>
      {children}
    </div>
  );
}

function StatusBadge({ status }: { status: VerificationStatus | "Stuck" }) {
  const ss = STATUS_STYLES[status] ?? STATUS_STYLES["Pending"];
  return (
    <span
      className="font-poppins text-[11px] font-semibold px-2.5 py-1 rounded-full shrink-0 dark:bg-opacity-20"
      style={{ color: ss.color, backgroundColor: ss.bg }}
    >
      {status}
    </span>
  );
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────

function DetailSkeleton() {
  return (
    <div className="flex flex-col md:flex-row gap-4 px-4 sm:px-6 flex-1 items-start animate-pulse">
      <div className="hidden md:flex flex-col gap-3 w-[175px] shrink-0">
        <div className="rounded-xl bg-muted w-full aspect-[175/210]" />
        <div className="rounded-xl bg-muted h-[160px]" />
        <div className="rounded-xl bg-muted h-[70px]" />
      </div>
      <div className="flex-1 w-full rounded-xl bg-muted h-[420px]" />
    </div>
  );
}

// ─── Left Panel ───────────────────────────────────────────────────────────────

const STATIC_BASE_URL = process.env.NEXT_PUBLIC_STATIC_BASE_URL;

function getFileUrl(filePath: string) {
  return `${STATIC_BASE_URL}/images/${filePath}`;
}

function LeftPanel({
  contact,
  status,
  isStuck = false,
}: {
  contact: TVerificationDetail["contact"];
  status: VerificationStatus | "Stuck";
  isStuck?: boolean;
}) {
  const ss = STATUS_STYLES[status] ?? STATUS_STYLES["Pending"];
  const [contactOpen, setContactOpen] = useState(false);

  const getInitials = (name: string) => {
    if (!name) return "?";
    return name
      .split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);
  };

  return (
    <>
      {/* ── MOBILE ── */}
      <div className="md:hidden flex flex-col gap-3">
        <div className="flex items-center gap-3 bg-card rounded-xl border border-border p-3">
          <div className="w-14 h-14 rounded-lg overflow-hidden shrink-0 bg-muted flex items-center justify-center">
            {contact.profileImageUrl ? (
              <Image
                src={contact.profileImageUrl}
                alt={contact.fullName || "Profile"}
                width={56} height={56}
                className="object-cover w-full h-full"
              />
            ) : (
              <div className="w-full h-full bg-primary/10 flex items-center justify-center">
                <span className="text-[16px] font-poppins font-bold text-primary">
                  {getInitials(contact.fullName)}
                </span>
              </div>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-poppins text-[13px] font-semibold text-foreground truncate">{contact.fullName || "—"}</p>
            <p className="font-poppins text-[11px] text-muted-foreground truncate">{contact.email || "—"}</p>
          </div>
          <StatusBadge status={status} />
        </div>

        <div className="bg-card rounded-xl border border-border overflow-hidden">
          <button
            onClick={() => setContactOpen((v) => !v)}
            className="w-full flex items-center justify-between px-3 py-2.5"
          >
            <span className="font-poppins text-[12px] font-semibold text-foreground">Contact Details</span>
            {contactOpen
              ? <ChevronUp className="w-4 h-4 text-muted-foreground" />
              : <ChevronDown className="w-4 h-4 text-muted-foreground" />
            }
          </button>
          {contactOpen && (
            <div className="px-3 pb-3 flex flex-col gap-2.5 border-t border-border pt-2.5">
              <ContactRow icon={<CreditCard    className="w-3 h-3" />} label="Full Name:"         value={contact.fullName}         />
              <ContactRow icon={<Phone         className="w-3 h-3" />} label="Phone Number:"      value={contact.phone}            />
              <ContactRow icon={<Mail          className="w-3 h-3" />} label="Email Address:"     value={contact.email}            />
              <ContactRow icon={<Briefcase     className="w-3 h-3" />} label="Location:"          value={contact.location}         />
              <ContactRow icon={<CalendarClock className="w-3 h-3" />} label="Registration Date:" value={contact.registrationDate} />
            </div>
          )}
        </div>
      </div>

      {/* ── DESKTOP ── */}
      <div className="hidden md:flex flex-col gap-3 shrink-0 w-[175px]">
        <div className="rounded-xl overflow-hidden bg-muted w-full aspect-[175/210] flex items-center justify-center">
          {contact.profileImageUrl ? (
            <Image
              src={contact.profileImageUrl}
              alt={contact.fullName || "Profile"}
              width={175} height={210}
              className="object-cover w-full h-full"
            />
          ) : (
            <div className="w-full h-full bg-primary/10 flex items-center justify-center">
              <span className="text-[48px] font-poppins font-bold text-primary">
                {getInitials(contact.fullName)}
              </span>
            </div>
          )}
        </div>

        <div className="bg-card rounded-xl border border-border p-3 flex flex-col gap-2.5">
          <h3 className="font-poppins text-[12px] font-semibold text-foreground">Contact Details</h3>
          <ContactRow icon={<CreditCard    className="w-3 h-3" />} label="Full Name:"         value={contact.fullName}         />
          <ContactRow icon={<Phone         className="w-3 h-3" />} label="Phone Number:"      value={contact.phone}            />
          <ContactRow icon={<Mail          className="w-3 h-3" />} label="Email Address:"     value={contact.email}            />
          <ContactRow icon={<Briefcase     className="w-3 h-3" />} label="Location:"          value={contact.location}         />
          <ContactRow icon={<CalendarClock className="w-3 h-3" />} label="Registration Date:" value={contact.registrationDate} />
        </div>

        <div className="bg-card rounded-xl border border-border p-3">
          <h3 className="font-poppins text-[12px] font-semibold text-foreground mb-2.5">Status</h3>
          <div className="flex items-center gap-2">
            <div
              className="w-6 h-6 rounded-full flex items-center justify-center text-white font-poppins font-bold shrink-0 text-[10px]"
              style={{ backgroundColor: ss.color }}
            >
              {isStuck ? "!" : status[0]}
            </div>
            <span className="font-poppins text-[11px] font-medium text-foreground">{status}</span>
          </div>
          {isStuck && (
            <p className="font-poppins text-[10px] text-amber-500 mt-2">
              No verification request found
            </p>
          )}
        </div>
      </div>
    </>
  );
}

// ─── Tab Bar ──────────────────────────────────────────────────────────────────

function TabBar({ active, onChange }: { active: TabId; onChange: (t: TabId) => void }) {
  const tabs: { id: TabId; label: string }[] = [
    { id: "overview",  label: "Overview"  },
    { id: "documents", label: "Documents" },
    { id: "history",   label: "History"   },
  ];
  return (
    <div className="flex border-b border-border mb-4 overflow-x-auto scrollbar-none">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={`relative px-4 py-2 font-poppins text-[13px] font-medium whitespace-nowrap transition-colors shrink-0 ${
            active === t.id
              ? "text-[#1c3866] dark:text-[#8b9cf4]"
              : "text-muted-foreground"
          }`}
        >
          {t.label}
          {active === t.id && (
            <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-[#1c3866] dark:bg-[#8b9cf4]" />
          )}
        </button>
      ))}
    </div>
  );
}

// ─── Stuck Doctor Overview Tab ───────────────────────────────────────────────

function StuckDoctorOverviewTab({ detail, onFix, isActioning }: { detail: StuckDoctorDetail; onFix: () => void; isActioning: boolean }) {
  return (
    <div className="flex flex-col lg:flex-row gap-3">
      <div className="flex flex-col gap-3 flex-1 min-w-0">
        {/* Alert Banner */}
        <div className="rounded-xl border border-amber-200 bg-amber-50 dark:bg-amber-500/10 dark:border-amber-500/30 p-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
            <div className="flex-1">
              <h4 className="font-poppins text-[13px] font-semibold text-amber-700 dark:text-amber-400">
                Doctor is Stuck
              </h4>
              <p className="font-poppins text-[12px] text-amber-600 dark:text-amber-300 mt-0.5">
                This doctor has been stuck in {detail.status} for {detail.daysStuck} days with no verification request.
                {detail.hasProfile 
                  ? " They have completed their profile but never submitted license information."
                  : " They have not completed their profile yet."}
              </p>
            </div>
          </div>
        </div>

        <SectionCard title="Doctor Information">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
            <InfoRow label="Full Name:" value={detail.fullName} />
            <InfoRow label="Email:" value={detail.email} />
            <InfoRow label="Phone:" value={detail.phoneNumber} />
            <InfoRow label="Status:" value={detail.status} />
            <InfoRow label="Registered:" value={formatDate(detail.createdAt)} />
            <InfoRow label="Days Stuck:" value={`${detail.daysStuck} days`} />
            <InfoRow label="Profile Status:" value={detail.hasProfile ? "✅ Completed" : "❌ Not Completed"} />
            {detail.profileCompletedAt && (
              <InfoRow label="Profile Completed:" value={formatDate(detail.profileCompletedAt)} />
            )}
          </div>
        </SectionCard>

        {detail.doctor_profiles && (
          <SectionCard title="Profile Details">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
              <InfoRow label="Gender:" value={detail.doctor_profiles.gender} />
              <InfoRow label="Date of Birth:" value={formatDate(detail.doctor_profiles.dateOfBirth)} />
              <InfoRow label="Nationality:" value={detail.doctor_profiles.nationality} />
              <InfoRow label="Contact Number:" value={detail.doctor_profiles.contactNumber} />
              <InfoRow label="Residential Address:" value={detail.doctor_profiles.residentialAddress} />
            </div>
          </SectionCard>
        )}
      </div>

      {/* Right Panel - Action */}
      <div className="w-full lg:w-[220px] lg:shrink-0">
        <SectionCard title="Actions">
          <div className="flex flex-col gap-3">
            <button
              onClick={onFix}
              disabled={isActioning}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed text-white font-poppins text-[12px] font-semibold rounded-lg transition-all"
            >
              {isActioning ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
              {isActioning ? "Creating..." : "Create Verification"}
            </button>
            <p className="font-poppins text-[10px] text-muted-foreground text-center">
              This will create a verification request and move this doctor to the pending queue.
            </p>
          </div>
        </SectionCard>
      </div>
    </div>
  );
}

// ─── Overview Tab — Doctor ────────────────────────────────────────────────────

function DoctorOverviewTab({ detail }: { detail: TVerificationDetail }) {
  return (
    <div className="flex flex-col lg:flex-row gap-3">
      <div className="flex flex-col gap-3 flex-1 min-w-0">
        <SectionCard title="License Information">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
            <InfoRow label="License Number:"      value={detail.license.licenseNumber}                          />
            <InfoRow label="License Type:"        value={detail.license.licenseType}                           />
            <InfoRow label="Issuing Authority:"   value={detail.license.issuingAuthority}                      />
            <InfoRow label="Country:"             value={detail.license.countryCode}                           />
            <InfoRow label="Issue Date:"          value={formatDate(detail.license.issueDate)}                 />
            <InfoRow label="Expiry Date:"         value={formatDate(detail.license.expiryDate)}                />
            <InfoRow label="Years of Experience:" value={detail.license.yearsOfExperience}                     />
            <InfoRow label="Specialization:"      value={detail.license.areasOfSpecialization?.join(", ")}     />
            <InfoRow label="Medical Institution:" value={detail.license.medicalInstitution}                    />
          </div>
        </SectionCard>

        {detail.practice && (
          <SectionCard title="Practice Information">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
              <InfoRow label="Clinic Name:"      value={detail.practice.clinicName}        />
              <InfoRow label="Location:"         value={detail.practice.location}          />
              <InfoRow label="Available From:"   value={detail.practice.daysAvailableFrom} />
              <InfoRow label="Available To:"     value={detail.practice.daysAvailableTo}   />
              <InfoRow label="Time From:"        value={formatDate(detail.practice.timeAvailableFrom)} />
              <InfoRow label="Time To:"          value={formatDate(detail.practice.timeAvailableTo)}   />
              <InfoRow label="Consultation Fee:" value={detail.practice.consultationFee}   />
            </div>
          </SectionCard>
        )}

        {detail.education && (
          <SectionCard title="Education">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
              <InfoRow label="Institution:" value={detail.education.institution}  />
              <InfoRow label="Degree:"      value={detail.education.degree}       />
              <InfoRow label="Field:"       value={detail.education.fieldOfStudy} />
              <InfoRow label="Start Year:"  value={detail.education.startYear}    />
              <InfoRow label="End Year:"    value={detail.education.endYear}      />
            </div>
          </SectionCard>
        )}
      </div>

      {detail.queue && (
        <div className="w-full lg:w-[220px] lg:shrink-0">
          <SectionCard title="Queue Info">
            <div className="flex flex-col gap-3">
              <InfoRow label="Priority:"       value={detail.queue.priority}                         />
              <InfoRow label="SLA Breached:"   value={detail.queue.slaBreached ? "Yes" : "No"}       />
              <InfoRow label="Escalated:"      value={detail.queue.escalated ? "Yes" : "No"}         />
              <InfoRow label="SLA Target:"     value={formatDate(detail.queue.slaTarget, true)}      />
              <InfoRow label="Added to Queue:" value={formatDate(detail.queue.addedToQueueAt, true)} />
            </div>
          </SectionCard>
        </div>
      )}
    </div>
  );
}

// ─── Overview Tab — Pharmacy ──────────────────────────────────────────────────

function PharmacyOverviewTab({ detail }: { detail: PharmacyVerificationDetail }) {
  return (
    <div className="flex flex-col lg:flex-row gap-3">
      <div className="flex flex-col gap-3 flex-1 min-w-0">
        <SectionCard title="Business Information">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
            <InfoRow label="Business Name:"       value={detail.business.businessName}       />
            <InfoRow label="Registration Number:" value={detail.business.registrationNumber} />
            <InfoRow label="Business Address:"    value={detail.business.businessAddress}    />
            <InfoRow label="Website:"             value={detail.business.website}            />
            <InfoRow label="License Number:"      value={detail.business.licenseNumber}      />
            <InfoRow label="License Expiry:"      value={formatDate(detail.business.licenseExpiryDate)} />
          </div>
        </SectionCard>

        {detail.business.operatingHours && (
          <SectionCard title="Operating Hours">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
              {Object.entries(detail.business.operatingHours).map(([day, hours]) => (
                <InfoRow key={day} label={day} value={hours as string} />
              ))}
            </div>
          </SectionCard>
        )}
      </div>
    </div>
  );
}

// ─── Overview Tab — Lab ───────────────────────────────────────────────────────

function LabOverviewTab({ detail }: { detail: LabVerificationDetail }) {
  return (
    <div className="flex flex-col lg:flex-row gap-3">
      <div className="flex flex-col gap-3 flex-1 min-w-0">
        <SectionCard title="Business Information">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
            <InfoRow label="Business Name:"       value={detail.business.businessName}       />
            <InfoRow label="Registration Number:" value={detail.business.registrationNumber} />
            <InfoRow label="License Number:"      value={detail.business.licenseNumber}      />
            <InfoRow label="Facility Type:"       value={detail.business.facilityType}       />
            <InfoRow label="Address:"             value={detail.business.businessAddress}    />
            <InfoRow label="City:"                value={detail.business.city}               />
            <InfoRow label="State:"               value={detail.business.state}              />
            <InfoRow label="Country:"             value={detail.business.country}            />
            <InfoRow label="Website:"             value={detail.business.website}            />
            <InfoRow label="Phone:"               value={detail.business.phone}              />
            <InfoRow label="Email:"               value={detail.business.email}              />
            <InfoRow label="Staff Count:"         value={detail.business.staffCount}         />
          </div>
        </SectionCard>
        {detail.approvedBy && (
          <SectionCard title="Approval Information">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
              <InfoRow label="Approved By:" value={detail.approvedBy.fullName} />
              <InfoRow label="Approved At:" value={formatDate(detail.approvedAt)} />
            </div>
          </SectionCard>
        )}

        {detail.business.servicesOffered && detail.business.servicesOffered.length > 0 && (
          <SectionCard title="Services Offered">
            <div className="flex flex-wrap gap-2">
              {detail.business.servicesOffered.map((s) => (
                <span
                  key={s}
                  className="px-2.5 py-1 rounded-full bg-muted text-[11px] font-poppins text-[#1c3866] dark:text-[#8b9cf4]"
                >
                  {s}
                </span>
              ))}
            </div>
          </SectionCard>
        )}
      </div>
    </div>
  );
}

// ─── Documents Tab ────────────────────────────────────────────────────────────

function DocumentsTab({
  documents,
}: {
  documents: TVerificationDetail["documents"] | PharmacyVerificationDetail["documents"] | LabVerificationDetail["documents"];
}) {
  return (
    <div className="rounded-xl border border-border overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-card">
        <span className="font-poppins text-[12px] font-semibold text-foreground">
          Documents ({documents.length})
        </span>
      </div>
      <div className="flex flex-col bg-card divide-y divide-border">
        {documents.length === 0 ? (
          <p className="text-center py-10 text-[13px] font-poppins text-muted-foreground">No documents uploaded.</p>
        ) : (
          documents.map((doc, i) => {
            const name = doc.name;
            const rawPath = "filePath" in doc ? doc.filePath : "file" in doc && doc.file ? doc.file.path : "url" in doc ? doc.url : "";
            const fileUrl = rawPath ? (rawPath.startsWith("http") ? rawPath : getFileUrl(rawPath)) : "";
            const fileSize = "fileSize" in doc ? `${(doc.fileSize / 1024 / 1024).toFixed(2)} MB` : "file" in doc && doc.file ? `${(doc.file.size / 1024 / 1024).toFixed(2)} MB` : "—";
            const uploadedAt = "uploadedAt" in doc ? doc.uploadedAt : "createdAt" in doc ? doc.createdAt : "";

            return (
              <div key={i} className="flex flex-col sm:flex-row sm:items-center sm:justify-between px-4 py-3 gap-2 hover:bg-muted/50 transition-colors">
                <div className="flex items-center gap-1 min-w-0">
                  <span className="font-poppins text-[12px] text-foreground truncate">{name}</span>
                </div>
                <div className="flex items-center gap-4 shrink-0">
                  {uploadedAt && (
                    <div className="flex items-center gap-1 text-muted-foreground">
                      <Calendar className="w-3 h-3" />
                      <span className="font-poppins text-[11px]">{formatDate(uploadedAt)}</span>
                    </div>
                  )}
                  <span className="font-poppins text-[11px] text-muted-foreground w-14 text-right">{fileSize}</span>
                  <div className="flex items-center gap-2.5">
                    <button
                      onClick={() => fileUrl && window.open(fileUrl, "_blank")}
                      className="text-muted-foreground hover:text-[#1c3866] dark:hover:text-[#8b9cf4] transition-colors"
                      title="Preview"
                    >
                      <EyeOff className="w-3.5 h-3.5" />
                    </button>
                    <a
                      href={fileUrl || undefined}
                      download
                      className="text-muted-foreground hover:text-[#1c3866] dark:hover:text-[#8b9cf4] transition-colors"
                      title="Download"
                    >
                      <Download className="w-3.5 h-3.5" />
                    </a>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ─── History Tab ──────────────────────────────────────────────────────────────

function HistoryTab({ history }: { history: TVerificationDetail["history"] }) {
  return (
    <div>
      <h3 className="font-poppins text-[12px] font-semibold text-foreground mb-3">Status History</h3>
      <div className="flex flex-col gap-2">
        {history.length === 0 ? (
          <p className="text-center py-10 text-[13px] font-poppins text-muted-foreground">No history available.</p>
        ) : (
          history.map((entry) => {
            const ss = STATUS_STYLES[entry.toStatus] ?? STATUS_STYLES["Pending"];
            return (
              <div key={entry.id} className="bg-card rounded-xl border border-border px-4 py-3">
                <div className="flex items-center gap-1.5 mb-0.5">
                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: ss.color }} />
                  <span className="font-poppins text-[11px] font-semibold" style={{ color: ss.color }}>
                    {entry.toStatus}
                  </span>
                </div>
                <p className="font-poppins text-[11px] text-foreground">{entry.changeReason ?? "—"}</p>
                <p className="font-poppins text-[10px] text-muted-foreground mt-0.5">
                  {formatDate(entry.changedAt, true)}
                </p>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ─── Reject Modal ─────────────────────────────────────────────────────────────

function RejectModal({
  role,
  onClose,
  onConfirm,
  isLoading,
}: {
  role: VerificationRole;
  onClose: () => void;
  onConfirm: (reason: string, notes?: string) => void;
  isLoading: boolean;
}) {
  const [reason, setReason] = useState("");
  const [notes, setNotes]   = useState("");
  const supportsNotes = role !== "Labs";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
      <div className="bg-card rounded-2xl p-6 w-full max-w-md shadow-xl border border-border">
        <h2 className="font-poppins text-[15px] font-semibold text-foreground mb-4">Reject Verification</h2>

        <div className="flex flex-col gap-3">
          <div>
            <label className="font-poppins text-[11px] text-muted-foreground font-medium">
              Rejection Reason <span className="text-red-500">*</span>
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="Enter reason for rejection..."
              className="mt-1 w-full border border-border rounded-lg px-3 py-2 text-[12px] font-poppins text-foreground bg-background outline-none focus:border-[#1c3866] dark:focus:border-[#8b9cf4] resize-none placeholder:text-muted-foreground"
            />
          </div>

          {supportsNotes && (
            <div>
              <label className="font-poppins text-[11px] text-muted-foreground font-medium">
                Review Notes (optional)
              </label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                placeholder="Additional notes..."
                className="mt-1 w-full border border-border rounded-lg px-3 py-2 text-[12px] font-poppins text-foreground bg-background outline-none focus:border-[#1c3866] dark:focus:border-[#8b9cf4] resize-none placeholder:text-muted-foreground"
              />
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button
            onClick={onClose}
            className="h-[36px] px-5 rounded-lg border border-border text-[12px] font-poppins text-muted-foreground hover:bg-muted transition-colors"
          >
            Cancel
          </button>
          <button
            disabled={!reason.trim() || isLoading}
            onClick={() => onConfirm(reason, notes || undefined)}
            className="h-[36px] px-5 rounded-lg bg-[#F64545] text-white text-[12px] font-poppins font-semibold hover:opacity-90 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {isLoading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Confirm Reject
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Action Footer ────────────────────────────────────────────────────────────

function ActionFooter({
  onReject,
  onApprove,
  isLoading,
  status,
}: {
  onReject: () => void;
  onApprove: () => void;
  isLoading: boolean;
  status: VerificationStatus;
}) {
  if (status !== "Pending") return null;

  return (
    <div className="flex flex-col-reverse sm:flex-row justify-end gap-3 px-4 sm:px-6 py-4 bg-muted/60 border-t border-border">
      <button
        disabled={isLoading}
        onClick={onReject}
        className="font-poppins text-[13px] font-semibold text-white rounded-lg hover:opacity-90 transition-all h-10 px-6 sm:px-9 disabled:opacity-50 disabled:cursor-not-allowed bg-[#F64545]"
      >
        Reject
      </button>
      <button
        disabled={isLoading}
        onClick={onApprove}
        className="font-poppins text-[13px] font-semibold text-white rounded-lg hover:opacity-90 transition-all h-10 px-6 sm:px-9 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 bg-[#0DA53F]"
      >
        {isLoading && <Loader2 className="w-4 h-4 animate-spin" />}
        Approve
      </button>
    </div>
  );
}

// ─── Stuck Doctor Type ────────────────────────────────────────────────────────

interface StuckDoctorDetail {
  id: string;
  fullName: string;
  email: string;
  phoneNumber: string | null;
  status: string;
  createdAt: string;
  hasProfile: boolean;
  profileCompletedAt: string | null;
  daysStuck: number;
  doctor_profiles?: {
    gender: string | null;
    dateOfBirth: string | null;
    nationality: string | null;
    contactNumber: string | null;
    residentialAddress: string | null;
    profilePhoto?: string | null;
  } | null;
}

// ─── Main Export ──────────────────────────────────────────────────────────────

interface Props { id: string }

export default function VerificationDetail({ id }: Props) {
  const router       = useRouter();
  const searchParams = useSearchParams();
  const role         = (searchParams.get("role") ?? "Doctors") as VerificationRole;

  const currentDetail   = useVerificationStore((s) => s.currentDetail);
  const isLoadingDetail = useVerificationStore((s) => s.isLoadingDetail);
  const isActioning     = useVerificationStore((s) => s.isActioning);
  const error           = useVerificationStore((s) => s.error);
  const fetchDetail     = useVerificationStore((s) => s.fetchDetail);
  const setActiveRole   = useVerificationStore((s) => s.setActiveRole);
  const clearDetail     = useVerificationStore((s) => s.clearDetail);
  const approve         = useVerificationStore((s) => s.approve);
  const reject          = useVerificationStore((s) => s.reject);
  const clearError      = useVerificationStore((s) => s.clearError);

  // Stuck doctor state
  const [stuckDetail, setStuckDetail] = useState<StuckDoctorDetail | null>(null);
  const [isLoadingStuck, setIsLoadingStuck] = useState(false);
  const [isFixing, setIsFixing] = useState(false);

  const [activeTab,  setActiveTab]  = useState<TabId>("overview");
  const [showReject, setShowReject] = useState(false);
  const [toast, setToast] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const isStuck = role === "Stuck";

  useEffect(() => {
    setActiveRole(role);

    if (isStuck) {
  const fetchStuckDetail = async () => {
  setIsLoadingStuck(true);
  try {
    const response = await api.get(`/api/verification/stuck-doctors/${id}`);
    setStuckDetail(response.data.data);
  } catch (err: any) {
    console.error("Failed to fetch stuck doctor:", err);
    setToast({ type: "error", message: err.response?.data?.message || "Failed to load stuck doctor details" });
  } finally {
    setIsLoadingStuck(false);
  }
};
      fetchStuckDetail();
    } else {
      fetchDetail(id);
    }
    return () => clearDetail();
  }, [id, role]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  const handleApprove = async () => {
    try {
      await approve(id);
      setToast({ type: "success", message: "Verification approved successfully." });
    } catch {
      setToast({ type: "error", message: "Failed to approve. Please try again." });
    }
  };

  const handleReject = async (reason: string, notes?: string) => {
    try {
      await reject(id, reason, notes);
      setShowReject(false);
      setToast({ type: "success", message: "Verification rejected successfully." });
    } catch {
      setToast({ type: "error", message: "Failed to reject. Please try again." });
    }
  };

 const handleFixStuckDoctor = async () => {
  setIsFixing(true);
  try {
    const response = await api.post(`/api/verification/stuck-doctors/${id}/fix`);
    setToast({ type: "success", message: "Verification request created successfully!" });
    setTimeout(() => {
      router.push(`/dashboard/verification/${response.data.data.id}?role=Doctors`);
    }, 1500);
  } catch (err: unknown) {
    setToast({ type: "error", message: readHttpErrorMessage(err) || "Failed to create verification." });
  } finally {
    setIsFixing(false);
  }
};

  const isDoctor   = role === "Doctors" || role === "All";
  const isPharmacy = role === "Pharmacies";
  const isLab      = role === "Labs";
  const isDispatch = role === "Dispatch";

  const doctorDetail   = isDoctor   ? (currentDetail as TVerificationDetail)          : null;
  const pharmacyDetail = isPharmacy ? (currentDetail as PharmacyVerificationDetail)   : null;
  const labDetail      = isLab      ? (currentDetail as LabVerificationDetail)         : null;
  const dispatchDetail = isDispatch ? (currentDetail as DispatchVerificationDetail)    : null;

  const hasHistory = (isDoctor && doctorDetail && "history" in doctorDetail) || isLab;
  const isLoading = isLoadingDetail || isLoadingStuck;

  // ── Stuck Doctor Loading ──
  if (isStuck && isLoadingStuck) {
    return <DetailSkeleton />;
  }

  // ── Stuck Doctor Render ──
  if (isStuck && stuckDetail) {
    const contact = {
      fullName: stuckDetail.fullName,
      phone: stuckDetail.phoneNumber || "",
      email: stuckDetail.email,
      location: stuckDetail.doctor_profiles?.residentialAddress || "",
      registrationDate: formatDate(stuckDetail.createdAt),
      profileImageUrl: stuckDetail.doctor_profiles?.profilePhoto || null,
    };

    return (
      <div className="flex flex-col bg-background min-h-screen">
        {/* ── Toast ── */}
        {toast && (
          <div className={`fixed top-5 right-5 z-[100] px-4 py-3 rounded-[10px] shadow-lg text-[13px] font-poppins text-white transition-all ${
            toast.type === "success" ? "bg-green-500" : "bg-red-500"
          }`}>
            {toast.message}
          </div>
        )}

        {/* ── Breadcrumb ── */}
        <div className="px-4 sm:px-6 pt-4 sm:pt-5 pb-3 flex items-center gap-2">
          <button
            onClick={() => router.back()}
            className="flex items-center gap-1.5 text-muted-foreground hover:text-[#1c3866] dark:hover:text-[#8b9cf4] transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span className="font-poppins text-[12px] font-medium">Back</span>
          </button>
          <span className="text-muted-foreground text-[12px]">/</span>
          <span className="font-poppins text-[12px] font-medium text-[#1c3866] dark:text-[#8b9cf4]">Stuck Doctor Detail</span>
        </div>

        {/* ── Error banner ── */}
        {error && (
          <div className="mx-4 sm:mx-6 mb-3 px-4 py-2.5 rounded-lg bg-red-500/10 border border-red-500/30 flex items-center justify-between">
            <span className="text-[12px] font-poppins text-red-500">{error}</span>
            <button onClick={clearError} className="text-[11px] font-poppins text-red-400 hover:text-red-500 ml-4">
              Dismiss
            </button>
          </div>
        )}

        {/* ── Body ── */}
        <div className="flex flex-col md:flex-row gap-4 px-4 sm:px-6 flex-1 items-start">
          <LeftPanel contact={contact} status="Stuck" isStuck={true} />

          <div className="flex-1 min-w-0 w-full">
            <div className="bg-card rounded-xl border border-border">
              <div className="p-3 sm:p-4">
                <TabBar active={activeTab} onChange={setActiveTab} />

                {activeTab === "overview" && (
                  <StuckDoctorOverviewTab detail={stuckDetail} onFix={handleFixStuckDoctor} isActioning={isFixing} />
                )}

                {activeTab === "documents" && (
                  <div className="rounded-xl border border-border p-8 text-center">
                    <FileText className="w-12 h-12 text-muted-foreground mx-auto mb-3" />
                    <p className="font-poppins text-[13px] text-muted-foreground">
                      No documents available for stuck doctors.
                    </p>
                    <p className="font-poppins text-[11px] text-muted-foreground mt-1">
                      This doctor has not submitted any verification documents yet.
                    </p>
                  </div>
                )}

                {activeTab === "history" && (
                  <div className="rounded-xl border border-border p-8 text-center">
                    <Clock className="w-12 h-12 text-muted-foreground mx-auto mb-3" />
                    <p className="font-poppins text-[13px] text-muted-foreground">
                      No history available.
                    </p>
                    <p className="font-poppins text-[11px] text-muted-foreground mt-1">
                      This doctor has no verification history because they never submitted a request.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Regular Loading ──
  if (isLoading || !currentDetail) {
    return <DetailSkeleton />;
  }

  // ── Dispatch Detail ──
  if (isDispatch && dispatchDetail) {
    return (
      <div className="flex flex-col bg-background min-h-screen">
        <div className="px-4 sm:px-6 pt-4 sm:pt-5 pb-3 flex items-center gap-2">
          <button
            onClick={() => router.back()}
            className="flex items-center gap-1.5 text-muted-foreground hover:text-[#1c3866] dark:hover:text-[#8b9cf4] transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span className="font-poppins text-[12px] font-medium">Back</span>
          </button>
          <span className="text-muted-foreground text-[12px]">/</span>
          <span className="font-poppins text-[12px] font-medium text-[#1c3866] dark:text-[#8b9cf4]">Dispatch Detail</span>
        </div>
        <div className="px-4 sm:px-6 flex-1">
          <DispatchDetail detail={dispatchDetail} />
        </div>
      </div>
    );
  }

  // ── Regular Verification Detail ──
  return (
    <div className="flex flex-col bg-background min-h-screen">

      {/* ── Toast ── */}
      {toast && (
        <div className={`fixed top-5 right-5 z-[100] px-4 py-3 rounded-[10px] shadow-lg text-[13px] font-poppins text-white transition-all ${
          toast.type === "success" ? "bg-green-500" : "bg-red-500"
        }`}>
          {toast.message}
        </div>
      )}

      {/* ── Breadcrumb ── */}
      <div className="px-4 sm:px-6 pt-4 sm:pt-5 pb-3 flex items-center gap-2">
        <button
          onClick={() => router.back()}
          className="flex items-center gap-1.5 text-muted-foreground hover:text-[#1c3866] dark:hover:text-[#8b9cf4] transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span className="font-poppins text-[12px] font-medium">Back</span>
        </button>
        <span className="text-muted-foreground text-[12px]">/</span>
        <span className="font-poppins text-[12px] font-medium text-[#1c3866] dark:text-[#8b9cf4]">Verification Detail</span>
      </div>

      {/* ── Error banner ── */}
      {error && (
        <div className="mx-4 sm:mx-6 mb-3 px-4 py-2.5 rounded-lg bg-red-500/10 border border-red-500/30 flex items-center justify-between">
          <span className="text-[12px] font-poppins text-red-500">{error}</span>
          <button onClick={clearError} className="text-[11px] font-poppins text-red-400 hover:text-red-500 ml-4">
            Dismiss
          </button>
        </div>
      )}

      {/* ── Body ── */}
      <div className="flex flex-col md:flex-row gap-4 px-4 sm:px-6 flex-1 items-start">
        <LeftPanel contact={(currentDetail as TVerificationDetail).contact} status={currentDetail.status} />

        <div className="flex-1 min-w-0 w-full">
          <div className="bg-card rounded-xl border border-border">
            <div className="p-3 sm:p-4">
              <TabBar active={activeTab} onChange={setActiveTab} />

              {activeTab === "overview" && (
                <>
                  {doctorDetail   && <DoctorOverviewTab   detail={doctorDetail}   />}
                  {pharmacyDetail && <PharmacyOverviewTab detail={pharmacyDetail} />}
                  {labDetail      && <LabOverviewTab      detail={labDetail}      />}
                </>
              )}

              {activeTab === "documents" && (
                <DocumentsTab documents={(currentDetail as TVerificationDetail).documents} />
              )}

              {activeTab === "history" && (
                <>
                  {isDoctor && doctorDetail && "history" in doctorDetail && (
                    <HistoryTab history={doctorDetail!.history} />
                  )}
                  {isLab && labDetail && (
                    <div className="flex flex-col gap-2">
                      <h3 className="font-poppins text-[12px] font-semibold text-foreground mb-3">
                        Status History
                      </h3>
                      {[
                        labDetail.approvedAt && {
                          label: "Approved",
                          date: labDetail.approvedAt,
                          color: "#0DA53F",
                          by: labDetail.approvedBy?.fullName ?? "Admin",
                        },
                        labDetail.rejectedAt && {
                          label: "Rejected",
                          date: labDetail.rejectedAt,
                          color: "#F64545",
                          reason: labDetail.rejectionReason,
                          by: "Admin",
                        },
                      ]
                        .filter(Boolean)
                        .map((entry: any, i) => (
                          <div key={i} className="bg-card rounded-xl border border-border px-4 py-3">
                            <div className="flex items-center gap-1.5 mb-0.5">
                              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: entry.color }} />
                              <span className="font-poppins text-[11px] font-semibold" style={{ color: entry.color }}>
                                {entry.label}
                              </span>
                            </div>
                            {entry.reason && (
                              <p className="font-poppins text-[11px] text-foreground">{entry.reason}</p>
                            )}
                            <p className="font-poppins text-[10px] text-muted-foreground mt-0.5">
                              {formatDate(entry.date, true)} — by {entry.by}
                            </p>
                          </div>
                        ))}
                      {!labDetail.approvedAt && !labDetail.rejectedAt && (
                        <p className="text-center py-10 text-[13px] font-poppins text-muted-foreground">
                          No history available yet.
                        </p>
                      )}
                    </div>
                  )}
                  {isPharmacy && (
                    <p className="text-center py-10 text-[13px] font-poppins text-muted-foreground">
                      History is not available for this verification type.
                    </p>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── Footer ── */}
      {!isLoading && currentDetail && !isDispatch && activeTab !== "history" && (
        <div className="mt-4">
          <ActionFooter
            status={currentDetail.status}
            isLoading={isActioning}
            onReject={() => setShowReject(true)}
            onApprove={handleApprove}
          />
        </div>
      )}

      {/* ── Reject Modal ── */}
      {showReject && (
        <RejectModal
          role={role}
          isLoading={isActioning}
          onClose={() => setShowReject(false)}
          onConfirm={handleReject}
        />
      )}
    </div>
  );
}