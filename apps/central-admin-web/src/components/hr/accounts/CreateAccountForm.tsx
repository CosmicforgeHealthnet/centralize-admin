"use client";
import { readHttpErrorMessage } from "@/lib/error-messages";

import { useEffect, useState, useRef } from "react";
import { ArrowLeft, Loader2, CheckCircle, AlertCircle, XCircle } from "lucide-react";
import { useHrmStore } from "@/stores/hrm.store";
import {
  ACCOUNT_DEPARTMENTS,
  ACCOUNT_TIERS,
  AccountDepartment,
  AccountMailProvisioningOutcome,
  AccountTier,
  formatEnumLabel,
} from "@/types/hrm.types";

const TIER_PERMISSIONS: Record<AccountTier, { heading: string; items: string[] }[]> = {
  SUPER: [
    {
      heading: "System-wide access",
      items: [
        "Full access to all modules (HRM, Finance, Operations, Marketing, etc.)",
        "Can view all data across departments",
      ],
    },
    {
      heading: "User & Access Control",
      items: [
        "Create, edit, delete ANY account (including admin)",
        "Assign or override roles, tiers, and permissions",
        "Approve or revoke access across system",
      ],
    },
    {
      heading: "Governance control",
      items: ["View all audit logs", "Access sensitive reports (company-wide performance, payroll, budgets)"],
    },
    {
      heading: "System control",
      items: ["Can configure system settings (RBAC structure, workflows, policies)", "Can approve system-level changes"],
    },
  ],
  EMPLOYEE: [
    {
      heading: "Personal access only",
      items: ["View own profile", "Update personal password after onboarding", "View assigned tasks / duties"],
    },
    {
      heading: "Work modules (based on role)",
      items: ["Access only modules relevant to position", "e.g. HR staff sees HR tools", "Finance staff sees finance tools"],
    },
    {
      heading: "Restrictions",
      items: [
        "Cannot view other employees (except where required for collaboration)",
        "Cannot create accounts",
        "Cannot access system settings",
        "Cannot modify permissions or roles",
        "Cannot view payroll unless explicitly allowed",
      ],
    },
  ],
  ADMIN: [
    {
      heading: "HRM Core Control",
      items: [
        "Create employee accounts (your onboarding system lives here)",
        "Edit employee details (department, role, tier updates)",
        "Assign roles and permissions (within allowed boundaries)",
      ],
    },
    {
      heading: "Operational control",
      items: ["Manage departments", "Handle attendance, leave approvals, payroll processing (if assigned module access)"],
    },
    {
      heading: "Limited system control",
      items: ["Cannot modify global RBAC structure", "Cannot override Super/Executive accounts", "Cannot access full system settings"],
    },
    {
      heading: "Account management",
      items: ["Activate / deactivate employee accounts", "Resend invites", "Reset employee credentials"],
    },
  ],
  EXECUTIVE: [
    {
      heading: "Read-heavy access",
      items: ["View all major dashboards (HRM, Finance, Operations, Marketing)", "Access high-level analytics and reports"],
    },
    {
      heading: "HRM access",
      items: [
        "Can view employees, departments, performance summaries",
        "Cannot directly create or delete accounts (optional override if needed per org policy)",
      ],
    },
    { heading: "Approvals", items: ["Can approve:", "  · budgets", "  · hires", "  · high-level requests"] },
    {
      heading: "Restrictions",
      items: [
        "Cannot modify system structure",
        "Cannot change RBAC or permission architecture",
        "Cannot access raw sensitive operational edits (like payroll editing)",
      ],
    },
  ],
};

function Label({ children }: { children: React.ReactNode }) {
  return <label className="font-poppins text-[12px] font-medium text-foreground mb-1 block">{children}</label>;
}

function Input({
  placeholder,
  value,
  onChange,
  type = "text",
}: {
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <input
      type={type}
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full h-[44px] px-3 rounded-xl border border-border bg-muted text-[12px] font-poppins text-foreground outline-none focus:border-primary/50 placeholder:text-muted-foreground transition-colors"
    />
  );
}

function SelectField({
  placeholder,
  value,
  onChange,
  options,
}: {
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  options: { label: string; value: string }[];
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full h-[44px] px-3 rounded-xl border border-border bg-muted text-[12px] font-poppins text-foreground outline-none focus:border-primary/50 appearance-none cursor-pointer transition-colors"
      >
        <option value="" disabled>{placeholder}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      <svg className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="6 9 12 15 18 9" />
      </svg>
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

function PermissionsBlock({ tier }: { tier: AccountTier }) {
  const perms = TIER_PERMISSIONS[tier];
  if (!perms) return null;

  return (
    <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 flex flex-col gap-3">
      {perms.map((group) => (
        <div key={group.heading}>
          <p className="font-poppins text-[11px] font-semibold text-primary mb-1">{group.heading}</p>
          <ul className="flex flex-col gap-0.5">
            {group.items.map((item, i) => (
              <li key={i} className="font-poppins text-[11px] text-primary/80 flex items-start gap-1.5">
                <span className="shrink-0 mt-0.5">·</span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

const TIER_OPTIONS = ACCOUNT_TIERS.map((t) => ({ label: formatEnumLabel(t), value: t }));
const DEPARTMENT_OPTIONS = ACCOUNT_DEPARTMENTS.map((d) => ({ label: formatEnumLabel(d), value: d }));

const EMPLOYMENT_TYPE_OPTIONS = [
  { label: "Full-Time", value: "Full-Time" },
  { label: "Part-Time", value: "Part-Time" },
];

const EMPLOYMENT_CATEGORY_OPTIONS = [
  { label: "Permanent", value: "Permanent" },
  { label: "Temporary", value: "Temporary" },
  { label: "Contract", value: "Contract" },
  { label: "Intern", value: "Intern" },
  { label: "Freelance", value: "Freelance" },
  { label: "Probationary", value: "Probationary" },
];

const JOB_TITLE_OPTIONS = [
  { label: "Software Engineer", value: "Software Engineer" },
  { label: "Senior Software Engineer", value: "Senior Software Engineer" },
  { label: "Product Manager", value: "Product Manager" },
  { label: "Project Manager", value: "Project Manager" },
  { label: "HR Manager", value: "HR Manager" },
  { label: "Marketing Manager", value: "Marketing Manager" },
  { label: "Sales Manager", value: "Sales Manager" },
  { label: "Customer Support Lead", value: "Customer Support Lead" },
  { label: "Operations Manager", value: "Operations Manager" },
  { label: "Team Lead", value: "Team Lead" },
  { label: "Director", value: "Director" },
  { label: "VP", value: "VP" },
  { label: "CTO", value: "CTO" },
  { label: "CEO", value: "CEO" },
  { label: "Other", value: "Other" },
];

const DESIGNATION_OPTIONS = [
  { label: "Individual Contributor", value: "Individual Contributor" },
  { label: "Team Lead", value: "Team Lead" },
  { label: "Manager", value: "Manager" },
  { label: "Senior Manager", value: "Senior Manager" },
  { label: "Director", value: "Director" },
  { label: "VP", value: "VP" },
  { label: "Executive", value: "Executive" },
  { label: "Other", value: "Other" },
];

const LOCATION_OPTIONS = [
  { label: "Abuja", value: "Abuja" },
  { label: "Lagos", value: "Lagos" },
  { label: "Port Harcourt", value: "Port Harcourt" },
  { label: "Ibadan", value: "Ibadan" },
  { label: "Enugu", value: "Enugu" },
  { label: "Kano", value: "Kano" },
  { label: "Remote", value: "Remote" },
  { label: "Hybrid", value: "Hybrid" },
];

const WORK_EMAIL_LOCAL_PART = /^[a-z0-9._+-]{1,64}$/;

function workEmailOutcomeMessage(outcome?: AccountMailProvisioningOutcome): string {
  if (!outcome) return "";
  if (outcome.status === "REQUESTED") return " A work email request was sent to IT for approval.";
  if (outcome.status === "SKIPPED") return " The work email request was skipped because CosmicForge Mail is not available yet.";
  return " The work email request could not be filed; ask IT to provision the mailbox.";
}

interface Props {
  mode?: "create" | "edit";
  accountId?: string;
  onBack: () => void;
  onSave?: () => void;
}

export default function CreateAccountForm({ mode = "create", accountId, onBack, onSave }: Props) {
  const isEdit = mode === "edit";

  const {
    selectedAccount,
    isLoadingAccount,
    isSavingAccount,
    accountsError,
    accountsSuccess,
    clearAccountsSuccess,
    fetchAccount,
    clearSelectedAccount,
    createAccount,
    updateAccount,
  } = useHrmStore();

  const formRef = useRef<HTMLDivElement>(null);

  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [department, setDepartment] = useState<string>("");
  const [designation, setDesignation] = useState("");
  const [empType, setEmpType] = useState("");
  const [empCategory, setEmpCategory] = useState("");
  const [location, setLocation] = useState("");
  const [tier, setTier] = useState<string>("EMPLOYEE");
  const [requestWorkEmail, setRequestWorkEmail] = useState(false);
  const [workEmailLocalPart, setWorkEmailLocalPart] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (accountsSuccess) {
      setSuccessMessage(accountsSuccess);
      setTimeout(() => {
        clearAccountsSuccess();
      }, 6000);
    }
  }, [accountsSuccess, clearAccountsSuccess]);

  useEffect(() => {
    if (successMessage || formError || accountsError) {
      if (formRef.current) {
        formRef.current.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      }
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, [successMessage, formError, accountsError]);

  useEffect(() => {
    if (isEdit && accountId) {
      fetchAccount(accountId);
    }
    return () => clearSelectedAccount();
  }, [isEdit, accountId, fetchAccount, clearSelectedAccount]);

  useEffect(() => {
    if (isEdit && selectedAccount) {
      setFullName(selectedAccount.name);
      setEmail(selectedAccount.email);
      setPhone(selectedAccount.phone ?? "");
      setJobTitle(selectedAccount.jobTitle ?? selectedAccount.position ?? "");
      setDepartment(selectedAccount.department ?? "");
      setDesignation(selectedAccount.designation ?? "");
      setEmpType(selectedAccount.employmentType ?? "");
      setEmpCategory(selectedAccount.employmentCategory ?? "");
      setLocation(selectedAccount.location ?? "");
      setTier(selectedAccount.tier);
    }
  }, [isEdit, selectedAccount]);

  const handleSubmit = async () => {
    setFormError(null);
    setSuccessMessage(null);
    setIsSubmitting(true);

    if (!fullName.trim() || !email.trim()) {
      setFormError("Full name and email are required.");
      setIsSubmitting(false);
      return;
    }

    const localPart = workEmailLocalPart.trim().toLowerCase();
    if (!isEdit && requestWorkEmail && localPart && !WORK_EMAIL_LOCAL_PART.test(localPart)) {
      setFormError("The work email name may only contain letters, numbers, dots, hyphens, underscores and plus signs.");
      setIsSubmitting(false);
      return;
    }

    try {
      if (isEdit && accountId) {
        await updateAccount(accountId, {
          name: fullName.trim(),
          email: email.trim(),
          position: jobTitle.trim() || undefined,
          department: (department || undefined) as AccountDepartment | undefined,
          tier: tier as AccountTier,
          employmentType: empType || undefined,
          employmentCategory: empCategory || undefined,
          location: location.trim() || undefined,
          personalPhone: phone.trim() || undefined,
        });
        setSuccessMessage("Account updated successfully!");
        setTimeout(() => setSuccessMessage(null), 6000);
      } else {
        const created = await createAccount({
          name: fullName.trim(),
          email: email.trim(),
          position: jobTitle.trim() || undefined,
          department: (department || undefined) as AccountDepartment | undefined,
          tier: tier as AccountTier,
          employmentType: empType || undefined,
          employmentCategory: empCategory || undefined,
          location: location.trim() || undefined,
          personalPhone: phone.trim() || undefined,
          ...(requestWorkEmail ? { mailProvisioning: { requested: true, localPart: localPart || undefined } } : {}),
        });

        setSuccessMessage(`Account created successfully! An invitation email has been sent.${workEmailOutcomeMessage(created?.mailProvisioning)}`);

        setTimeout(() => {
          if (!isEdit) {
            setFullName("");
            setEmail("");
            setPhone("");
            setJobTitle("");
            setDepartment("");
            setDesignation("");
            setEmpType("");
            setEmpCategory("");
            setLocation("");
            setTier("EMPLOYEE");
            setRequestWorkEmail(false);
            setWorkEmailLocalPart("");
          }
        }, 2000);

        setTimeout(() => {
          onSave?.();
        }, 3500);
      }
    } catch (err: unknown) {
      const errorMsg = readHttpErrorMessage(err) || (err instanceof Error ? err.message : undefined) || "Failed to save account";
      setFormError(errorMsg);
      setTimeout(() => setFormError(null), 6000);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isEdit && isLoadingAccount) {
    return (
      <div className="flex flex-col gap-5">
        <button onClick={onBack} className="flex items-center gap-1.5 text-muted-foreground hover:text-primary transition-colors w-fit">
          <ArrowLeft className="w-3.5 h-3.5" />
          <span className="font-poppins text-[12px] font-medium">Go Back</span>
        </button>
        <div className="h-[300px] bg-muted rounded-xl animate-pulse flex items-center justify-center">
          <Loader2 className="w-8 h-8 text-primary animate-spin" />
        </div>
      </div>
    );
  }

  return (
    <div ref={formRef} className="flex flex-col gap-5">
      <button onClick={onBack} className="flex items-center gap-1.5 text-muted-foreground hover:text-primary transition-colors w-fit">
        <ArrowLeft className="w-3.5 h-3.5" />
        <span className="font-poppins text-[12px] font-medium">Go Back</span>
      </button>

      {successMessage && (
        <div className="flex items-start gap-3 px-4 py-3 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 animate-in slide-in-from-top-2 duration-300">
          <CheckCircle className="w-5 h-5 text-emerald-500 dark:text-emerald-400 shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="font-poppins text-[13px] font-medium text-emerald-700 dark:text-emerald-300">Success</p>
            <p className="font-poppins text-[12px] text-emerald-600 dark:text-emerald-400">{successMessage}</p>
          </div>
          <button
            onClick={() => setSuccessMessage(null)}
            className="text-emerald-500 hover:text-emerald-700 dark:text-emerald-400 dark:hover:text-emerald-300 transition-colors"
          >
            <XCircle className="w-4 h-4" />
          </button>
        </div>
      )}

      {formError && (
        <div className="flex items-start gap-3 px-4 py-3 rounded-xl bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 animate-in slide-in-from-top-2 duration-300">
          <AlertCircle className="w-5 h-5 text-red-500 dark:text-red-400 shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="font-poppins text-[13px] font-medium text-red-700 dark:text-red-300">Error</p>
            <p className="font-poppins text-[12px] text-red-600 dark:text-red-400">{formError}</p>
          </div>
          <button
            onClick={() => setFormError(null)}
            className="text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 transition-colors"
          >
            <XCircle className="w-4 h-4" />
          </button>
        </div>
      )}

      {accountsError && !formError && (
        <div className="flex items-start gap-3 px-4 py-3 rounded-xl bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 animate-in slide-in-from-top-2 duration-300">
          <AlertCircle className="w-5 h-5 text-red-500 dark:text-red-400 shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="font-poppins text-[13px] font-medium text-red-700 dark:text-red-300">Error</p>
            <p className="font-poppins text-[12px] text-red-600 dark:text-red-400">{accountsError}</p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SectionCard title="Personal Information" subtitle="This contains employee information">
          <div className="flex flex-col gap-3">
            <div><Label>Employee Full Name</Label><Input placeholder="Enter Full Name" value={fullName} onChange={setFullName} /></div>
            <div><Label>Email Address</Label><Input type="email" placeholder="Enter email address" value={email} onChange={setEmail} /></div>
            <div><Label>Phone Number</Label><Input type="tel" placeholder="Enter Phone Number" value={phone} onChange={setPhone} /></div>
          </div>
        </SectionCard>

        <SectionCard title="Job Information" subtitle="This contains Job information">
          <div className="flex flex-col gap-3">
            <div>
              <Label>Job Title</Label>
              <SelectField placeholder="Select Job Title" value={jobTitle} onChange={setJobTitle} options={JOB_TITLE_OPTIONS} />
            </div>
            <div>
              <Label>Department</Label>
              <SelectField placeholder="Select Department" value={department} onChange={setDepartment} options={DEPARTMENT_OPTIONS} />
            </div>
            <div>
              <Label>Designation / Role</Label>
              <SelectField placeholder="Select Designation" value={designation} onChange={setDesignation} options={DESIGNATION_OPTIONS} />
            </div>
          </div>
        </SectionCard>
      </div>

      <SectionCard title="Employment Information" subtitle="This contains employee information">
        <div className="flex flex-col gap-3">
          <div>
            <Label>Employment Type</Label>
            <SelectField placeholder="Select Employment Type" value={empType} onChange={setEmpType} options={EMPLOYMENT_TYPE_OPTIONS} />
          </div>
          <div>
            <Label>Employment Category</Label>
            <SelectField placeholder="Select Employment Category" value={empCategory} onChange={setEmpCategory} options={EMPLOYMENT_CATEGORY_OPTIONS} />
          </div>
          <div>
            <Label>Location</Label>
            <SelectField placeholder="Select Location" value={location} onChange={setLocation} options={LOCATION_OPTIONS} />
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Account Classification" subtitle="This contains account classifications informations">
        <div className="flex flex-col gap-3">
          <div>
            <Label>Account Tier</Label>
            <SelectField placeholder="Select Tier" value={tier} onChange={setTier} options={TIER_OPTIONS} />
          </div>

          {tier && (
            <div>
              <Label>Account Permissions</Label>
              <PermissionsBlock tier={tier as AccountTier} />
            </div>
          )}
        </div>
      </SectionCard>

      {!isEdit && (
        <SectionCard title="Work Email" subtitle="Optionally request a professional email address for this employee">
          <div className="flex flex-col gap-3">
            <label className="flex items-center gap-2 cursor-pointer w-fit">
              <input
                type="checkbox"
                data-testid="request-work-email"
                checked={requestWorkEmail}
                onChange={(e) => setRequestWorkEmail(e.target.checked)}
                className="w-4 h-4 accent-primary"
              />
              <span className="font-poppins text-[12px] font-medium text-foreground">Request a work email address</span>
            </label>
            {requestWorkEmail && (
              <div>
                <Label>Email name (optional)</Label>
                <Input placeholder="e.g. jane.doe" value={workEmailLocalPart} onChange={setWorkEmailLocalPart} />
                <p className="font-poppins text-[11px] text-muted-foreground mt-1">
                  This files a request for IT. The mailbox is only created after IT approves it in Mail administration.
                </p>
              </div>
            )}
          </div>
        </SectionCard>
      )}

      {isEdit ? (
        <div className="grid grid-cols-2 gap-4 mt-2">
          <button
            onClick={onBack}
            disabled={isSavingAccount || isSubmitting}
            className="h-[50px] rounded-xl border border-border bg-muted text-[14px] font-poppins font-semibold text-muted-foreground hover:bg-muted/80 transition-colors disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={isSavingAccount || isSubmitting}
            className="h-[50px] rounded-xl bg-primary text-white text-[14px] font-poppins font-semibold hover:bg-primary/90 transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Saving...
              </>
            ) : (
              "Save Changes"
            )}
          </button>
        </div>
      ) : (
        <button
          onClick={handleSubmit}
          disabled={isSavingAccount || isSubmitting}
          className="w-full h-[50px] rounded-xl bg-primary text-white text-[14px] font-poppins font-semibold hover:bg-primary/90 transition-colors mt-2 disabled:opacity-60 flex items-center justify-center gap-2"
        >
          {isSubmitting ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Creating Account...
            </>
          ) : (
            "Onboard"
          )}
        </button>
      )}
    </div>
  );
}