// ─── List / Table ─────────────────────────────────────────────────────────────

export type VerificationStatus = "Pending" | "Approved" | "Failed";
export type RiskIndicator = "Low" | "Medium" | "High";
export type VerificationRole = "All" | "Doctors" | "Pharmacies" | "Labs" | "Dispatch" | "Stuck";
export type VerificationType = "License" | "Business" | "Identity";
export interface VerificationListItem {
  id: string;
  user: string;
  role: VerificationRole;
  verificationType: VerificationType;
  licenseId: string;
  status: VerificationStatus;
  submittedDate: string | null;
  riskIndicator: RiskIndicator;
  specialty?: string | null;
  profileImageUrl?: string | null;
  operationType?: string | null;
}

export interface VerificationStats {
  totalRequests: number;
  approvalRate: string;
  pendingRequests: number;
}

export interface VerificationPagination {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  itemsPerPage: number;
}

export interface VerificationListResponse {
  stats: VerificationStats;
  requests: VerificationListItem[];
  pagination: VerificationPagination;
}

export interface VerificationSubListResponse {
  requests: VerificationListItem[];
  pagination: VerificationPagination;
}

// ─── Filters ──────────────────────────────────────────────────────────────────

export interface VerificationFilters {
  status: string;
  startDate: string;
  endDate: string;
  search: string;
  page: number;
  limit: number;
}

// ─── Stuck Doctors ─────────────────────────────────────────────────────────────

export interface StuckDoctor {
  id: string;
  fullName: string;
  email: string;
  phoneNumber: string | null;
  createdAt: string;
  hasProfile: boolean;
  profileCompletedAt: string | null;
  daysStuck: number;
}

export interface StuckDoctorStats {
  totalStuck: number;
  noProfile: number;
  hasProfile: number;
}

export interface StuckDoctorResponse {
  stats: StuckDoctorStats;
  doctors: StuckDoctor[];
  pagination: VerificationPagination;
}

// ─── Detail ───────────────────────────────────────────────────────────────────

export interface VerificationContact {
  fullName: string;
  phone: string;
  email: string;
  location: string;
  registrationDate: string;
  profileImageUrl: string | null;
}

export interface VerificationLicense {
  licenseNumber: string;
  licenseType: string;
  issuingAuthority: string;
  countryCode: string;
  issueDate: string | null;
  expiryDate: string | null;
  yearsOfExperience: number | null;
  areasOfSpecialization: string[];
  subspecialty: string;
  medicalInstitution: string;
  licenseDocumentUrl: string | null;
}

export interface VerificationEducation {
  institution: string | null;
  degree: string | null;
  fieldOfStudy: string | null;
  startYear: number | null;
  endYear: number | null;
  certificateName: string | null;
  issuingBody: string | null;
  issueDate: string | null;
  expiryDate: string | null;
  certificateDocumentUrl: string | null;
}

export interface VerificationPractice {
  clinicName: string | null;
  location: string | null;
  daysAvailableFrom: string | null;
  daysAvailableTo: string | null;
  timeAvailableFrom: string | null;
  timeAvailableTo: string | null;
  consultationFee: number | null;
}

export interface VerificationDocument {
  id: string;
  name: string;
  documentType: string;
  status: string;
  filePath: string;
  fileSize: number;
  mimeType: string;
  uploadedAt: string;
  ocrConfidence: number | null;
  rejectionReason: string | null;
}

export interface VerificationHistoryEntry {
  id: string;
  fromStatus: string | null;
  toStatus: string;
  changedBy: string;
  changeReason: string | null;
  automatedChange: boolean;
  changedAt: string;
}

export interface VerificationQueue {
  priority: string;
  slaTarget: string | null;
  slaBreached: boolean;
  escalated: boolean;
  escalationReason: string | null;
  addedToQueueAt: string;
}

export interface VerificationDetail {
  id: string;
  status: VerificationStatus;
  riskIndicator: RiskIndicator;
  method: string | null;
  tier: string | null;
  submittedAt: string;
  approvedAt: string | null;
  rejectedAt: string | null;
  expiresAt: string | null;
  reviewNotes: string | null;
  rejectionReason: string | null;
  contact: VerificationContact;
  license: VerificationLicense;
  education: VerificationEducation | null;
  practice: VerificationPractice | null;
  documents: VerificationDocument[];
  history: VerificationHistoryEntry[];
  queue: VerificationQueue | null;
  assignedReviewer: { id: string; fullName: string; email: string } | null;
}

// ─── Pharmacy Detail ──────────────────────────────────────────────────────────

export interface PharmacyBusiness {
  businessName: string;
  registrationNumber: string;
  businessAddress: string;
  licenseNumber: string;
  licenseExpiryDate: string | null;
  website: string;
  description: string;
  operatingHours: Record<string, string> | null;
}

export interface PharmacyDocument {
  id: string;
  name: string;
  documentType: string;
  isVerified: boolean;
  submissionStatus: string;
  verificationNotes: string | null;
  createdAt: string;
  file: {
    id: string;
    name: string;
    path: string;
    size: number;
    mimeType: string;
  } | null;
}

export interface PharmacyVerificationDetail {
  id: string;
  status: VerificationStatus;
  riskIndicator: RiskIndicator;
  priority: string;
  requestType: string;
  submittedAt: string;
  reviewedAt: string | null;
  completedAt: string | null;
  requestNotes: string | null;
  rejectionReason: string | null;
  reviewNotes: string | null;
  contact: VerificationContact;
  business: PharmacyBusiness;
  documents: PharmacyDocument[];
}

// ─── Lab Detail ───────────────────────────────────────────────────────────────

export interface LabBusiness {
  businessName: string;
  registrationNumber: string;
  licenseNumber: string;
  facilityType: string | null;
  businessAddress: string;
  city: string | null;
  state: string | null;
  country: string | null;
  website: string;
  phone: string;
  email: string;
  staffCount: number | null;
  operatingHours: Record<string, string> | null;
  servicesOffered: string[] | null;
  equipmentList: string[] | null;
}

export interface LabDocument {
  name: string;
  url: string;
  type: string;
}

export interface LabVerificationDetail {
  id: string;
  status: VerificationStatus;
  riskIndicator: RiskIndicator;
  createdAt: string;
  approvedAt: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  contact: VerificationContact;
  business: LabBusiness;
  documents: LabDocument[];
  approvedBy: { id: string; fullName: string } | null;
}

// ─── Dispatch Detail ──────────────────────────────────────────────────────────

export interface DispatchVerificationDocument {
  id: string;
  document_type: string;
  file_url: string;
  file_size?: number | null;
  mime_type?: string | null;
  uploaded_at: string;
}

export interface DispatchFaceCheck {
  id: string;
  selfie_url: string;
  id_doc_url: string;
  match_score: number | null;
  result: string | null;
  provider_used: string;
  checked_at: string;
}

export interface DispatchVerificationStep {
  id: string;
  step: string;
  status: string;
  submitted_at: string | null;
  reviewed_at: string | null;
  reviewer_id: string | null;
  rejection_reason: string | null;
  updated_at: string;
  verification_documents?: DispatchVerificationDocument[];
  face_checks?: DispatchFaceCheck[];
  provider?: {
    full_name: string;
    phone: string;
    email?: string;
    operation_type?: string;
    bikes?: DispatchBike[];
  };
}

export interface DispatchBikeDocument {
  id: string;
  document_type: string;
  file_url: string;
  status: string;
  uploaded_at: string;
}

export interface DispatchBike {
  id: string;
  bike_type: string;
  brand: string;
  model: string;
  year: number | null;
  color: string;
  plate_number: string;
  verification_status: string;
  is_active: boolean;
  is_primary: boolean;
  bike_documents: DispatchBikeDocument[];
}

export interface DispatchGuarantor {
  id: string;
  full_name: string;
  phone: string;
  email: string | null;
  relationship: string;
  address: string | null;
}

export interface DispatchEmergencyContact {
  id: string;
  full_name: string;
  phone: string;
  relationship: string;
}

export interface DispatchAuditLog {
  id: string;
  provider_id: string;
  step: string;
  action: string;
  from_status: string;
  to_status: string;
  performed_by: string;
  notes: string | null;
  created_at: string;
  performedByAdmin: { id: string; name: string; email: string } | null;
}

export interface DispatchVerificationDetail {
  id: string;
  status: VerificationStatus;
  rawStatus: string;
  riskIndicator: RiskIndicator;
  full_name: string;
  email: string;
  phone: string;
  state: string | null;
  city: string | null;
  operation_type: string | null;
  avg_rating: number | null;
  total_trips: number;
  is_active: boolean;
  onboarding_complete: boolean;
  created_at: string;
  verification_steps: DispatchVerificationStep[];
  bikes: DispatchBike[];
  guarantors: DispatchGuarantor[];
  emergency_contacts: DispatchEmergencyContact[];
  verificationAudit: DispatchAuditLog[];
}

// ─── Action responses ─────────────────────────────────────────────────────────

export interface VerificationActionResponse {
  id: string;
  status: VerificationStatus;
}

export interface DispatchStepActionResponse {
  providerId: string;
  step: string;
  status: string;
}

export interface DispatchSuspendResponse {
  providerId: string;
  status: string;
}