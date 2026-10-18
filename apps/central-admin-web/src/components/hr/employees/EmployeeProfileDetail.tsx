"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import {
  ArrowLeft,
  CreditCard,
  Phone,
  Mail,
  Briefcase,
  Calendar,
  Users,
  Eye,
  EyeOff,
  Download,
  Pencil,
} from "lucide-react";
import { useHrmStore } from "@/stores/hrm.store";
import { EmployeeDetail } from "@/types/hrm.types";

// ─── Types ────────────────────────────────────────────────────────────────────

type TabId = "personal" | "employment" | "documents" | "reports" | "performance";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function InfoItem({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <span className="font-poppins text-[10px] text-muted-foreground">{label}</span>
      <span className="font-poppins text-[12px] font-semibold text-foreground break-words">
        {value || "—"}
      </span>
    </div>
  );
}

function SectionCard({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border p-4 bg-card">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-poppins text-[13px] font-semibold text-foreground">{title}</h3>
        {action}
      </div>
      {children}
    </div>
  );
}

function EditBtn() {
  return (
    <button className="text-muted-foreground hover:text-primary transition-colors">
      <Pencil className="w-3.5 h-3.5" />
    </button>
  );
}

function formatDate(value?: string | null) {
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return value;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

function formatCurrency(value?: number | null) {
  if (value === null || value === undefined) return null;
  return `₦ ${value.toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;
}

// ─── Tab Bar ──────────────────────────────────────────────────────────────────

function TabBar({ active, onChange }: { active: TabId; onChange: (t: TabId) => void }) {
  const tabs: { id: TabId; label: string }[] = [
    { id: "personal",    label: "Personal Info"       },
    { id: "employment",  label: "Employment Details"  },
    { id: "documents",   label: "Documents"           },
    { id: "reports",     label: "Reports"             },
    { id: "performance", label: "Performance"         },
  ];
  return (
    <div className="flex border-b border-border overflow-x-auto scrollbar-none">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={`relative px-4 py-2.5 font-poppins text-[12px] font-medium whitespace-nowrap transition-colors shrink-0 ${
            active === t.id
              ? "text-primary"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {t.label}
          {active === t.id && (
            <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-primary rounded-t-full" />
          )}
        </button>
      ))}
    </div>
  );
}

// ─── Left Panel ───────────────────────────────────────────────────────────────

function LeftPanel({ emp }: { emp: EmployeeDetail }) {
  return (
    <div className="flex flex-col gap-3 w-full md:w-[175px] md:shrink-0">
      {/* Avatar */}
      <div className="w-full md:w-[175px] md:h-[210px] h-[160px] rounded-xl overflow-hidden bg-muted flex items-center justify-center">
        {emp.avatarUrl ? (
          <Image src={emp.avatarUrl} alt={emp.name} width={175} height={210} className="object-cover w-full h-full" />
        ) : (
          <div className="w-full h-full bg-primary/10 flex items-center justify-center">
            <span className="text-[48px] font-poppins font-bold text-primary">{emp.name.charAt(0)}</span>
          </div>
        )}
      </div>

      {/* Quick Info */}
      <div className="bg-card rounded-xl border border-border p-3 flex flex-col gap-2.5">
        <div className="flex items-start gap-2">
          <CreditCard className="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5" />
          <div className="flex flex-col">
            <span className="font-poppins text-[10px] text-muted-foreground">Employee ID:</span>
            <span className="font-poppins text-[11px] font-semibold text-foreground">{emp.employeeCode || emp.id}</span>
          </div>
        </div>
        <div className="flex items-start gap-2">
          <Phone className="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5" />
          <div className="flex flex-col">
            <span className="font-poppins text-[10px] text-muted-foreground">Phone Number:</span>
            <span className="font-poppins text-[11px] font-semibold text-foreground">{emp.contactInfo.workPhone || "—"}</span>
          </div>
        </div>
        <div className="flex items-start gap-2">
          <Mail className="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5" />
          <div className="flex flex-col">
            <span className="font-poppins text-[10px] text-muted-foreground">Email Address:</span>
            <span className="font-poppins text-[11px] font-semibold text-foreground break-all">{emp.email}</span>
          </div>
        </div>
        <div className="flex items-start gap-2">
          <Calendar className="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5" />
          <div className="flex flex-col">
            <span className="font-poppins text-[10px] text-muted-foreground">Employment Date:</span>
            <span className="font-poppins text-[11px] font-semibold text-foreground">
              {formatDate(emp.employmentInfo.employmentDate) || "—"}
            </span>
          </div>
        </div>
        <div className="flex items-start gap-2">
          <Briefcase className="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5" />
          <div className="flex flex-col">
            <span className="font-poppins text-[10px] text-muted-foreground">Position:</span>
            <span className="font-poppins text-[11px] font-semibold text-foreground">{emp.employmentInfo.position || "—"}</span>
          </div>
        </div>
        <div className="flex items-start gap-2">
          <Briefcase className="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5" />
          <div className="flex flex-col">
            <span className="font-poppins text-[10px] text-muted-foreground">Location:</span>
            <span className="font-poppins text-[11px] font-semibold text-foreground">{emp.employmentInfo.location || "—"}</span>
          </div>
        </div>
        <div className="flex items-start gap-2">
          <Users className="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5" />
          <div className="flex flex-col">
            <span className="font-poppins text-[10px] text-muted-foreground">Head of Department:</span>
            <span className="font-poppins text-[11px] font-semibold text-foreground">
              {emp.employmentInfo.headOfDepartment || "—"}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Personal Info Tab ────────────────────────────────────────────────────────

function PersonalInfoTab({ emp }: { emp: EmployeeDetail }) {
  return (
    <div className="flex flex-col gap-3">
      {/* Personal Info + Contact Info side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <SectionCard title="Personal Info" action={<EditBtn />}>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3">
            <InfoItem label="Name:"             value={emp.name}                            />
            <InfoItem label="Preferred Name:"   value={emp.personalInfo.preferredName}       />
            <InfoItem label="Birthday:"         value={formatDate(emp.personalInfo.birthday)}/>
            <InfoItem label="Nationality:"      value={emp.personalInfo.nationality}         />
            <InfoItem label="Gender:"           value={emp.personalInfo.gender}              />
            <InfoItem label="Marital Status:"   value={emp.personalInfo.maritalStatus}       />
          </div>
        </SectionCard>

        <SectionCard title="Contact Info" action={<EditBtn />}>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3">
            <InfoItem label="Work Phone:"         value={emp.contactInfo.workPhone}    />
            <InfoItem label="Home Phone:"         value={emp.contactInfo.homePhone}    />
            <InfoItem label="Fax:"                value={emp.contactInfo.fax}          />
            <InfoItem label="Work Email Address:" value={emp.email}                    />
            <InfoItem label="Personal Phone:"     value={emp.contactInfo.personalPhone}/>
            <InfoItem label="Address:"            value={emp.contactInfo.address}      />
            <InfoItem label="State:"              value={emp.contactInfo.state}        />
            <InfoItem label="Country:"            value={emp.contactInfo.country}      />
          </div>
        </SectionCard>
      </div>

      {/* Education */}
      <SectionCard title="Education & Certifications">
        {emp.education.length === 0 ? (
          <p className="font-poppins text-[12px] text-muted-foreground">No education records yet.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {emp.education.map((edu, i) => (
              <div key={edu.id} className={i < emp.education.length - 1 ? "pb-3 border-b border-border" : ""}>
                <p className="font-poppins text-[12px] font-semibold text-foreground">{edu.degreeTitle}</p>
                <p className="font-poppins text-[11px] text-muted-foreground mt-0.5">{edu.institution}</p>
                <p className="font-poppins text-[11px] text-muted-foreground">
                  {formatDate(edu.from)} - {formatDate(edu.to) || "Present"}
                </p>
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      {/* Employment Info */}
      <SectionCard title="Employment Info" action={<EditBtn />}>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-x-4 gap-y-3">
          <InfoItem label="Position:"            value={emp.employmentInfo.position}                    />
          <InfoItem label="Department:"          value={emp.employmentInfo.department}                  />
          <InfoItem label="Employment Type:"     value={emp.employmentInfo.employmentType}              />
          <InfoItem label="Employment Category:" value={emp.employmentInfo.employmentCategory}          />
          <InfoItem label="Employment Date:"     value={formatDate(emp.employmentInfo.employmentDate)} />
          <InfoItem label="Location:"            value={emp.employmentInfo.location}                    />
        </div>
      </SectionCard>

      {/* Emergency Contact */}
      <SectionCard title="Emergency Contact" action={<EditBtn />}>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-3">
          <InfoItem label="Next of Kin:"    value={emp.emergencyContact.name}     />
          <InfoItem label="Phone Number:"   value={emp.emergencyContact.phone}    />
          <InfoItem label="Email Address:"  value={emp.emergencyContact.email}    />
          <InfoItem label="Relationship:"   value={emp.emergencyContact.relation} />
        </div>
      </SectionCard>

      {/* Social */}
      <SectionCard title="Social" action={<EditBtn />}>
        {emp.socialLinks.length === 0 ? (
          <p className="font-poppins text-[12px] text-muted-foreground">No social links added.</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-x-4 gap-y-3">
            {emp.socialLinks.map((link) => (
              <InfoItem key={link.id} label={`${link.platform}:`} value={link.username} />
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

// ─── Employment Details Tab ───────────────────────────────────────────────────

function SensitiveRow({
  label,
  value,
  revealed,
  onToggle,
  onEdit,
}: {
  label: string;
  value: string | null;
  revealed: boolean;
  onToggle: () => void;
  onEdit: () => void;
}) {
  return (
    <div className="rounded-xl border border-border p-4 bg-card">
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-poppins text-[13px] font-semibold text-foreground">{label}</h3>
        <div className="flex items-center gap-2">
          {revealed && (
            <button onClick={onEdit} className="text-muted-foreground hover:text-primary transition-colors">
              <Pencil className="w-3.5 h-3.5" />
            </button>
          )}
          <button onClick={onToggle} className="text-muted-foreground hover:text-primary transition-colors">
            {revealed ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>
      {revealed ? (
        <div className="flex flex-col gap-0.5">
          <span className="font-poppins text-[10px] text-muted-foreground">
            {label.includes("Equity") ? "Total Equity" : label.includes("Salary") ? "Total Salary" : "Total Bonus"}
          </span>
          <span className="font-poppins text-[13px] font-semibold text-foreground">{value || "—"}</span>
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <div className="h-2 w-16 bg-muted rounded-full" />
          <div className="h-2 w-24 bg-muted rounded-full" />
        </div>
      )}
    </div>
  );
}

function EmploymentDetailsTab({ emp }: { emp: EmployeeDetail }) {
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const toggle = (key: string) => setRevealed((r) => ({ ...r, [key]: !r[key] }));

  const hasSensitiveAccess = !!emp.sensitive;

  return (
    <div className="flex flex-col gap-3">
      <SectionCard title="Employment Info" action={<EditBtn />}>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-x-4 gap-y-3">
          <InfoItem label="Position:"            value={emp.employmentInfo.position}                    />
          <InfoItem label="Department:"          value={emp.employmentInfo.department}                  />
          <InfoItem label="Employment Type:"     value={emp.employmentInfo.employmentType}              />
          <InfoItem label="Employment Category:" value={emp.employmentInfo.employmentCategory}          />
          <InfoItem label="Employment Date:"     value={formatDate(emp.employmentInfo.employmentDate)} />
          <InfoItem label="Location:"            value={emp.employmentInfo.location}                    />
        </div>
      </SectionCard>

      {hasSensitiveAccess ? (
        <>
          <SensitiveRow
            label="Equity Info"
            value={formatCurrency(emp.sensitive?.equity ?? null)}
            revealed={!!revealed["equity"]}
            onToggle={() => toggle("equity")}
            onEdit={() => {}}
          />
          <SensitiveRow
            label="Salary Info"
            value={formatCurrency(emp.sensitive?.salary ?? null)}
            revealed={!!revealed["salary"]}
            onToggle={() => toggle("salary")}
            onEdit={() => {}}
          />
          <SensitiveRow
            label="Bonus Info"
            value={formatCurrency(emp.sensitive?.bonus ?? null)}
            revealed={!!revealed["bonus"]}
            onToggle={() => toggle("bonus")}
            onEdit={() => {}}
          />
        </>
      ) : (
        <p className="font-poppins text-[12px] text-muted-foreground">
          You don&apos;t have permission to view salary, bonus, or equity details.
        </p>
      )}
    </div>
  );
}

// ─── Documents Tab ────────────────────────────────────────────────────────────

function DocumentsTab({ emp }: { emp: EmployeeDetail }) {
  return (
    <div className="rounded-xl border border-border overflow-hidden bg-card">
      {emp.documents.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3">
          <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center">
            <CreditCard className="w-7 h-7 text-muted-foreground" />
          </div>
          <p className="font-poppins text-[13px] text-muted-foreground">This User has no Documents yet.</p>
        </div>
      ) : (
        <div className="flex flex-col divide-y divide-border">
          {emp.documents.map((doc) => (
            <div
              key={doc.id}
              className="flex items-center justify-between px-4 py-3 hover:bg-muted/30 transition-colors"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-poppins text-[12px] text-foreground truncate">{doc.name}</span>
                <span className="font-poppins text-[10px] text-muted-foreground shrink-0">.{doc.type}</span>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <a
                  href={doc.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted-foreground hover:text-primary transition-colors"
                  title="Preview"
                >
                  <EyeOff className="w-3.5 h-3.5" />
                </a>
                <a
                  href={doc.url}
                  download
                  className="text-muted-foreground hover:text-primary transition-colors"
                  title="Download"
                >
                  <Download className="w-3.5 h-3.5" />
                </a>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Reports Tab ─────────────────────────────────────────────────────────────

function ReportsTab({ emp }: { emp: EmployeeDetail }) {
  if (emp.reports.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-3">
        <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center">
          <CreditCard className="w-7 h-7 text-muted-foreground" />
        </div>
        <p className="font-poppins text-[13px] text-muted-foreground">This User has no Report yet.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {emp.reports.map((report) => (
        <SectionCard key={report.id} title={report.title}>
          <p className="font-poppins text-[12px] text-foreground">{report.body || report.note || "—"}</p>
          <p className="font-poppins text-[10px] text-muted-foreground mt-2">{formatDate(report.date)}</p>
        </SectionCard>
      ))}
    </div>
  );
}

// ─── Performance Tab ──────────────────────────────────────────────────────────

function PerformanceTab({ emp }: { emp: EmployeeDetail }) {
  if (emp.performanceNotes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-3">
        <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center">
          <CreditCard className="w-7 h-7 text-muted-foreground" />
        </div>
        <p className="font-poppins text-[13px] text-muted-foreground">No performance data available yet.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {emp.performanceNotes.map((note) => (
        <SectionCard key={note.id} title={note.title}>
          <p className="font-poppins text-[11px] text-muted-foreground">{formatDate(note.date)}</p>
        </SectionCard>
      ))}
    </div>
  );
}

// ─── Loading State ─────────────────────────────────────────────────────────────

function LoadingState() {
  return (
    <div className="flex flex-col gap-3 animate-pulse">
      <div className="h-5 w-40 bg-muted rounded" />
      <div className="flex flex-col md:flex-row gap-4">
        <div className="w-full md:w-[175px] md:h-[210px] h-[160px] rounded-xl bg-muted" />
        <div className="flex-1 h-[300px] rounded-xl bg-muted" />
      </div>
    </div>
  );
}

// ─── Main Export ──────────────────────────────────────────────────────────────

export default function EmployeeProfileDetail({
  employeeId,
  onBack,
}: {
  employeeId: string;
  onBack: () => void;
}) {
  const [activeTab, setActiveTab] = useState<TabId>("personal");
  const { selectedEmployee, isLoadingDetail, error, fetchEmployee, clearSelectedEmployee } = useHrmStore();

  useEffect(() => {
    fetchEmployee(employeeId);
    return () => clearSelectedEmployee();
  }, [employeeId, fetchEmployee, clearSelectedEmployee]);

  return (
    <div className="flex flex-col gap-4">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-muted-foreground hover:text-primary transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span className="font-poppins text-[12px] font-medium">All Employees</span>
        </button>
        <span className="text-muted-foreground text-[12px]">/</span>
        <span className="font-poppins text-[12px] font-medium text-primary">Employee Profile Details</span>
      </div>

      {/* Title */}
      <h2 className="font-poppins text-[14px] font-semibold text-foreground">Employee Profile</h2>

      {isLoadingDetail || !selectedEmployee ? (
        error ? (
          <p className="font-poppins text-[12px] text-red-500">{error}</p>
        ) : (
          <LoadingState />
        )
      ) : (
        <div className="flex flex-col md:flex-row gap-4 items-start">
          <LeftPanel emp={selectedEmployee} />

          {/* Right: tabs + content */}
          <div className="flex-1 min-w-0 w-full bg-card rounded-xl border border-border overflow-hidden">
            <TabBar active={activeTab} onChange={setActiveTab} />
            <div className="p-4">
              {activeTab === "personal"    && <PersonalInfoTab      emp={selectedEmployee} />}
              {activeTab === "employment"  && <EmploymentDetailsTab emp={selectedEmployee} />}
              {activeTab === "documents"   && <DocumentsTab         emp={selectedEmployee} />}
              {activeTab === "reports"     && <ReportsTab           emp={selectedEmployee} />}
              {activeTab === "performance" && <PerformanceTab       emp={selectedEmployee} />}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}