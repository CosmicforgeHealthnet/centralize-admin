export type ConsultationStatus = "pending" | "scheduled" | "completed" | "cancelled";
export type RTCStatus = "scheduled" | "active" | "completed" | "cancelled";
export type PrescriptionStatus =
  | "pending"
  | "patient_uploaded"
  | "pharmacy_assigned"
  | "pharmacy_processing"
  | "ready_for_pickup"
  | "ready_for_delivery"
  | "completed"
  | "cancelled";
export type PaymentStatus = "pending" | "processing" | "completed" | "failed" | "disputed" | "refunded" | "cancelled";

export interface Pagination {
  currentPage: number;
  totalPages: number;
  totalItems: number;
}

export interface Consultation {
  id: string;
  patientId: string;
  doctorId: string;
  status: ConsultationStatus;
  appointmentDate: string;
  paymentStatus: string;
  createdAt: string;
}

export interface RTCSession {
  id: string;
  status: RTCStatus;
  doctorId: string;
  patientId: string;
  scheduledStartTime: string;
  actualStartTime: string | null;
  actualEndTime: string | null;
  appointmentId: string;
}

export interface Delivery {
  id: string;
  reference: string;
  status: PrescriptionStatus;
  patientId: string;
  pharmacyId: string | null;
  paymentStatus: string;
  availabilityStatus: string;
  createdAt: string;
}

export interface Transaction {
  id: string;
  patientId: string;
  serviceType: string;
  status: PaymentStatus;
  originalAmount: string;
  originalCurrency: string;
  fundsStatus: string;
  createdAt: string;
}

export interface AuditLog {
  id: string;
  resourceType: string;
  resourceId: string;
  action: string;
  actorUserId: string | null;
  actorRole: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface UserNotification {
  id: string;
  type: string;
  title: string;
  message: string;
  isRead: boolean;
  createdAt: string;
}

export interface ITStats {
  telemedicine: { total: number; pending: number; scheduled: number; completed: number; cancelled: number };
  rtc: { total: number; scheduled: number; active: number; completed: number; cancelled: number };
  logistics: { total: number; pending: number; processing: number; readyForDelivery: number; completed: number; cancelled: number };
  payments: { total: number; pending: number; completed: number; failed: number; refunded: number; monthlyRevenueUsd: string };
  audit: { total: number; today: number };
  notifications: { total: number; unread: number };
}

export interface ITFilters {
  search: string;
  status: string;
  page: number;
  limit: number;
}