"use client";

import { useState } from "react";
import { ArrowLeft, Calendar } from "lucide-react";
import { useHrmStore } from "@/stores/hrm.store";
import { VacancyStatus } from "@/types/hrm.types";

type Step = 1 | 2 | 3 | 4 | 5;

interface JobFormData {
  jobTitle: string;
  department: string;
  employmentCategory: string;
  employmentLocation: string;
  jobDescription: string;
  responsibilities: string;
  requirements: string;
  experienceLevel: string;
  salaryRange: string;
  benefitsAndBonus: string;
  deadline: string;
  numberOfOpening: string;
  hiringStages: string;
  assignedRecruiter: string;
}

const INITIAL: JobFormData = {
  jobTitle: "", department: "", employmentCategory: "", employmentLocation: "",
  jobDescription: "", responsibilities: "", requirements: "", experienceLevel: "",
  salaryRange: "", benefitsAndBonus: "",
  deadline: "", numberOfOpening: "", hiringStages: "", assignedRecruiter: "",
};

const STEPS = [
  { step: 1 as Step, label: "Job Information" },
  { step: 2 as Step, label: "Job Description" },
  { step: 3 as Step, label: "Compensation" },
  { step: 4 as Step, label: "Settings" },
  { step: 5 as Step, label: "Preview" },
];

const STEP_ICONS: Record<Step, React.ReactNode> = {
  1: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>,
  2: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>,
  3: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>,
  4: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/></svg>,
  5: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>,
};

function Label({ children, required }: { children: React.ReactNode; required?: boolean }) {
  return (
    <label className="font-poppins text-[12px] font-medium text-foreground mb-1 block">
      {children}{required && <span className="text-red-500 ml-0.5">*</span>}
    </label>
  );
}

function Input({ placeholder, value, onChange }: { placeholder: string; value: string; onChange: (v: string) => void }) {
  return (
    <input
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full h-[44px] px-3 rounded-xl border border-border bg-muted text-[12px] font-poppins text-foreground outline-none focus:border-primary/50 placeholder:text-muted-foreground transition-colors"
    />
  );
}

function Select({ placeholder, value, onChange, options }: { placeholder: string; value: string; onChange: (v: string) => void; options: string[] }) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full h-[44px] px-3 rounded-xl border border-border bg-muted text-[12px] font-poppins text-foreground outline-none focus:border-primary/50 appearance-none cursor-pointer transition-colors"
      >
        <option value="" disabled>{placeholder}</option>
        {options.map((o) => <option key={o}>{o}</option>)}
      </select>
      <svg className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="6 9 12 15 18 9"/>
      </svg>
    </div>
  );
}

function Textarea({ placeholder, value, onChange, rows = 4 }: { placeholder: string; value: string; onChange: (v: string) => void; rows?: number }) {
  return (
    <textarea
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={rows}
      className="w-full px-3 py-2.5 rounded-xl border border-border bg-muted text-[12px] font-poppins text-foreground outline-none focus:border-primary/50 placeholder:text-muted-foreground resize-none transition-colors"
    />
  );
}

function NextBtn({ onClick, isLoading }: { onClick: () => void; isLoading?: boolean }) {
  return (
    <div className="flex justify-end mt-3">
      <button
        onClick={onClick}
        disabled={isLoading}
        className="h-[36px] px-6 bg-primary/20 text-primary text-[12px] font-poppins font-semibold rounded-lg hover:bg-primary/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {isLoading ? "Loading..." : "Next"}
      </button>
    </div>
  );
}

function SectionCard({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="bg-card rounded-xl border border-border p-5 flex flex-col gap-4">
      <div>
        <h3 className="font-poppins text-[13px] font-semibold text-foreground">{title}</h3>
        <p className="font-poppins text-[11px] text-muted-foreground mt-0.5">{subtitle}</p>
      </div>
      {children}
    </div>
  );
}

function StepBar({ current }: { current: Step }) {
  return (
    <div className="grid grid-cols-5 gap-1 mb-6">
      {STEPS.map(({ step, label }) => {
        const isActive = step === current;
        const isCompleted = step < current;
        return (
          <div
            key={step}
            className={`flex flex-col items-center gap-1.5 px-2 py-3 rounded-xl border transition-colors ${
              isActive ? "border-primary bg-primary/5" :
              isCompleted ? "border-green-200 bg-green-50/50 dark:border-green-800 dark:bg-green-900/10" :
              "border-border bg-muted/30"
            }`}
          >
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
              isActive ? "bg-primary text-white" :
              isCompleted ? "bg-green-500 text-white" :
              "bg-muted text-muted-foreground"
            }`}>
              {STEP_ICONS[step]}
            </div>
            <div className="flex flex-col items-center">
              <span className="font-poppins text-[9px] text-muted-foreground">Step {step}/5</span>
              <span className={`font-poppins text-[10px] font-semibold text-center leading-tight ${isActive ? "text-primary" : "text-foreground"}`}>
                {label}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function JobPreviewStep({ data, onBack, onSubmit, isSubmitting }: { 
  data: JobFormData; 
  onBack: () => void; 
  onSubmit: () => void;
  isSubmitting: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="bg-card rounded-xl border border-border p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-poppins text-[13px] font-semibold text-foreground">Job Preview</h3>
          <button className="text-muted-foreground hover:text-foreground transition-colors">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/>
            </svg>
          </button>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {[
            { label: "Job Title", value: data.jobTitle || "—" },
            { label: "Department", value: data.department || "—" },
            { label: "Employment Category", value: data.employmentCategory || "—" },
            { label: "Location", value: data.employmentLocation || "—" },
            { label: "Application Deadline", value: data.deadline || "—" },
          ].map(({ label, value }) => (
            <div key={label} className="flex flex-col gap-0.5">
              <span className="font-poppins text-[10px] text-muted-foreground">{label}</span>
              <span className="font-poppins text-[12px] font-semibold text-foreground">{value}</span>
            </div>
          ))}
        </div>
      </div>

      {[
        { label: "Job Description", value: data.jobDescription || "—" },
        { label: "Responsibilities", value: data.responsibilities || "—" },
        { label: "Requirement", value: data.requirements || "—" },
      ].map(({ label, value }) => (
        <div key={label} className="bg-card rounded-xl border border-border p-4">
          <h4 className="font-poppins text-[12px] font-semibold text-foreground mb-2">{label}</h4>
          <p className="font-poppins text-[12px] text-muted-foreground leading-relaxed whitespace-pre-line">{value}</p>
        </div>
      ))}

      {[
        { label: "Experience Level", value: data.experienceLevel || "—" },
        { label: "Salary", value: data.salaryRange || "—" },
        { label: "Number of Opening", value: data.numberOfOpening || "—" },
        { label: "Hiring Stages", value: data.hiringStages || "—" },
      ].map(({ label, value }) => (
        <div key={label} className="bg-card rounded-xl border border-border p-4">
          <h4 className="font-poppins text-[12px] font-semibold text-foreground mb-1">{label}</h4>
          <p className="font-poppins text-[12px] text-muted-foreground">{value}</p>
        </div>
      ))}

      <button
        onClick={onSubmit}
        disabled={isSubmitting}
        className="w-full h-[50px] bg-primary text-white font-poppins text-[14px] font-semibold rounded-xl hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed mt-2"
      >
        {isSubmitting ? "Publishing..." : "Publish Job"}
      </button>
    </div>
  );
}

export default function CreateJobForm({ onBack }: { onBack: () => void }) {
  const [currentStep, setCurrentStep] = useState<Step>(1);
  const [form, setForm] = useState<JobFormData>(INITIAL);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { createVacancy, hiringError } = useHrmStore();

  const set = (key: keyof JobFormData) => (value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const next = () => setCurrentStep((s) => Math.min(5, s + 1) as Step);

  const handleSubmit = async () => {
    setIsSubmitting(true);
    try {
      await createVacancy({
        title: form.jobTitle,
        department: form.department || undefined,
        category: form.employmentCategory || undefined,
        location: form.employmentLocation || undefined,
        numberOfOpening: parseInt(form.numberOfOpening) || 1,
        experienceLevel: form.experienceLevel || undefined,
        salaryRange: form.salaryRange || undefined,
        benefitsAndBonus: form.benefitsAndBonus || undefined,
        jobDescription: form.jobDescription || undefined,
        responsibilities: form.responsibilities || undefined,
        requirements: form.requirements || undefined,
        hiringStages: form.hiringStages || undefined,
        assignedRecruiter: form.assignedRecruiter || undefined,
        deadline: form.deadline || undefined,
        status: "OPEN" as VacancyStatus,
      });
      onBack();
    } catch (error) {
      // Error is handled in the store
    } finally {
      setIsSubmitting(false);
    }
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

      {hiringError && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded-lg text-sm">
          {hiringError}
        </div>
      )}

      <div>
        <h2 className="font-poppins text-[18px] font-bold text-foreground">Job Overview</h2>
        <p className="font-poppins text-[12px] text-muted-foreground mt-0.5">
          This information helps potential candidates understand the role
        </p>
      </div>

      <StepBar current={currentStep} />

      {currentStep === 5 ? (
        <JobPreviewStep
          data={form}
          onBack={() => setCurrentStep(4)}
          onSubmit={handleSubmit}
          isSubmitting={isSubmitting}
        />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <SectionCard title="Job Information" subtitle="This information helps potential candidates understand the role">
            <div className="flex flex-col gap-3">
              <div><Label required>Job Title</Label><Input placeholder="Enter Title" value={form.jobTitle} onChange={set("jobTitle")} /></div>
              <div><Label>Department</Label><Select placeholder="Select Department" value={form.department} onChange={set("department")} options={["Design", "IT", "Marketing", "HR", "Finance"]} /></div>
              <div><Label>Employment Category</Label><Select placeholder="Select Category" value={form.employmentCategory} onChange={set("employmentCategory")} options={["Full-Time", "Part-Time", "Contract", "Remote", "Hybrid"]} /></div>
              <div><Label>Employment Location</Label><Input placeholder="Enter Location" value={form.employmentLocation} onChange={set("employmentLocation")} /></div>
            </div>
            <NextBtn onClick={next} />
          </SectionCard>

          <SectionCard title="Job Description" subtitle="This information helps potential candidates understand what's required.">
            <div className="flex flex-col gap-3">
              <div><Label>Job Description</Label><Textarea placeholder="Enter Description" value={form.jobDescription} onChange={set("jobDescription")} /></div>
              <div><Label>Responsibilities</Label><Textarea placeholder="Enter Responsibilities" value={form.responsibilities} onChange={set("responsibilities")} /></div>
              <div><Label>Requirements</Label><Textarea placeholder="Enter Requirements" value={form.requirements} onChange={set("requirements")} /></div>
              <div><Label>Experience Level</Label><Select placeholder="Select Level" value={form.experienceLevel} onChange={set("experienceLevel")} options={["Junior", "Intermediate", "Senior", "Lead"]} /></div>
            </div>
            <NextBtn onClick={next} />
          </SectionCard>

          <SectionCard title="Compensation" subtitle="This information helps potential candidates understand the compensation and benefits">
            <div className="flex flex-col gap-3">
              <div><Label>Salary Range</Label><Select placeholder="Select Range" value={form.salaryRange} onChange={set("salaryRange")} options={["100,000-300,000", "300,000-500,000", "500,000-800,000", "800,000-1,000,000", "1,000,000+"]} /></div>
              <div><Label>Benefits and Bonus</Label><Textarea placeholder="Enter Benefits" value={form.benefitsAndBonus} onChange={set("benefitsAndBonus")} rows={3} /></div>
            </div>
            <NextBtn onClick={next} />
          </SectionCard>

          <SectionCard title="Application Setting" subtitle="This information will be displayed publicly in the HR module">
            <div className="flex flex-col gap-3">
              <div>
                <Label>Deadline</Label>
                <div className="relative">
                  <input
                    type="date"
                    placeholder="Select Date"
                    value={form.deadline}
                    onChange={(e) => set("deadline")(e.target.value)}
                    className="w-full h-[44px] px-3 pr-10 rounded-xl border border-border bg-muted text-[12px] font-poppins text-foreground outline-none focus:border-primary/50 placeholder:text-muted-foreground transition-colors"
                  />
                  <Calendar className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                </div>
              </div>
              <div><Label>Number of Opening</Label><Input placeholder="Enter Number" value={form.numberOfOpening} onChange={set("numberOfOpening")} /></div>
              <div><Label>Hiring Stages</Label><Select placeholder="Select Stage" value={form.hiringStages} onChange={set("hiringStages")} options={["1", "2", "3", "4", "5"]} /></div>
              <div><Label>Assigned Recruiter</Label><Select placeholder="Select Recruiter" value={form.assignedRecruiter} onChange={set("assignedRecruiter")} options={["Recruiter A", "Recruiter B", "Recruiter C"]} /></div>
            </div>
            <NextBtn onClick={next} />
          </SectionCard>
        </div>
      )}
    </div>
  );
}