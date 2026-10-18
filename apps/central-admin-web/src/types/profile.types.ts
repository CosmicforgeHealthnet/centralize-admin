// ── Enums ────────────────────────────────────────────────────────────────────

export type AdminTier = "SUPER" | "EXECUTIVE" | "ADMIN" | "EMPLOYEE";

export type AdminStatus = "ACTIVE" | "INACTIVE" | "LOCKED" | "PENDING";

export type Department =
  | "FINANCE"
  | "DEVELOPMENT"
  | "CUSTOMER_CARE"
  | "MARKETING"
  | "SOCIAL_MEDIA"
  | "EXECUTIVE"
  | "MANAGEMENT";

// ── Sub-models ───────────────────────────────────────────────────────────────

export interface SocialLink {
  id: string;
  platform: string;
  username: string;
}

export interface Education {
  id: string;
  degreeTitle: string;
  institution: string;
  from: string | null;
  to: string | null;
}

export interface Document {
  id: string;
  name: string;
  type: string;
  uploadedAt: string;
  url: string | null;  
}

export interface PerformanceNote {
  id: string;
  title: string;
  type: string;
  date: string;
  url: string;
}

export interface Report {
  id: string;
  title: string;
  type: string;
  date: string;
  body: string | null;
  note: string | null;
  url?: string | null;
}

// ── Full Profile ─────────────────────────────────────────────────────────────

export interface Profile {
  id: string;
  email: string;
  name: string;
  position: string | null;
  department: Department | null;
  tier: AdminTier;
  status: AdminStatus;
  isTeamLead: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  mainAppUserId: string | null;
  avatarUrl: string | null;

  // Personal Info
  preferredName: string | null;
  birthday: string | null;
  nationality: string | null;
  gender: string | null;
  maritalStatus: string | null;

  // Contact Info
  workPhone: string | null;
  homePhone: string | null;
  personalPhone: string | null;
  fax: string | null;
  address: string | null;
  state: string | null;
  country: string | null;

  // Emergency Contact
  emergencyName: string | null;
  emergencyPhone: string | null;
  emergencyEmail: string | null;
  emergencyRelation: string | null;

  // Employment Details
  employmentType: string | null;
  employmentCategory: string | null;
  location: string | null;

  // Sensitive — only present for SUPER/EXECUTIVE
  salary?: string | null;
  bonus?: string | null;
  equity?: string | null;

  // Relations
  socialLinks: SocialLink[];
  educations: Education[];
  documents: Document[];
  performanceNotes: PerformanceNote[];
  reports: Report[];
}

// ── Request Payloads ─────────────────────────────────────────────────────────

export interface UpdatePersonalInfoPayload {
  preferredName?: string | null;
  birthday?: string | null;
  nationality?: string | null;
  gender?: string | null;
  maritalStatus?: string | null;
}

export interface UpdateContactInfoPayload {
  workPhone?: string | null;
  homePhone?: string | null;
  personalPhone?: string | null;
  fax?: string | null;
  address?: string | null;
  state?: string | null;
  country?: string | null;
}

export interface UpdateEmergencyContactPayload {
  emergencyName?: string | null;
  emergencyPhone?: string | null;
  emergencyEmail?: string | null;
  emergencyRelation?: string | null;
}

export interface UpdateSocialLinksPayload {
  links: { platform: string; username: string }[];
}

export interface UpdateEducationPayload {
  entries: {
    degreeTitle: string;
    institution: string;
    from?: string | null;
    to?: string | null;
  }[];
}

export interface AddReportPayload {
  file?: File;
  title: string;
  body?: string | null;
  note?: string | null;
}

// ── Response wrappers ────────────────────────────────────────────────────────

export interface DocumentDownloadResponse {
  url: string;
  name: string;
  type: string;
}

export interface ProjectItem {
  id: string;
  title: string;
  assignedDate: string;
  dueDate: string;
  status: "IN_PROGRESS" | "COMPLETED" | "OVERDUE";
  team: string;
  teamLead: string;
  members: number;
}

// ── Work Section ─────────────────────────────────────────────────────────────

export interface MemberAvatar {
  id: string;
  name: string;
  avatarUrl: string | null;
}

export interface ProjectDetail {
  id: string;
  title: string;
  description: string | null;
  assignedDate: string;
  dueDate: string;
  status: "IN_PROGRESS" | "COMPLETED" | "OVERDUE";
  team: string;
  teamLead: { name: string; avatarUrl: string | null } | null;
  members: MemberAvatar[];
}

export interface TaskItem {
  id: string;
  title: string;
  assignedDate: string;
  dueDate: string;
  status: "IN_PROGRESS" | "COMPLETED" | "OVERDUE";
  assigner: string;
}

export interface TaskDetail {
  id: string;
  title: string;
  description: string | null;
  assignedDate: string;
  dueDate: string;
  status: "IN_PROGRESS" | "COMPLETED" | "OVERDUE";
  assigner: { name: string; avatarUrl: string | null };
}

export interface TeamMember {
  id: string;
  name: string;
  avatarUrl?: string | null;
}

export interface TeamItem {
  id: string;
  title: string;
  members: TeamMember[];
}