// ─── Settings ─────────────────────────────────────────────────────────────────

export interface AdminSetting {
  id: string;
  category: string;
  key: string;
  value: any;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminSettingsGrouped {
  [category: string]: AdminSetting[];
}

export interface UpdateSettingPayload {
  category: string;
  key: string;
  value: any;
}

// ─── Value Shapes (for type safety) ──────────────────────────────────────────

export interface ChannelToggleValue {
  email: boolean;
  sms: boolean;
  inApp: boolean;
}

export interface NumericUnitValue {
  enabled: boolean;
  value: number;
  unit: "Seconds" | "Minutes" | "Hours" | "Days" | "Month";
}

export interface PlainNumberValue {
  enabled: boolean;
  value: number;
}

export interface TagListValue {
  enabled: boolean;
  tags: string[];
}

export interface BooleanValue {
  enabled: boolean;
}

// ─── History / Audit ─────────────────────────────────────────────────────────

export interface SettingHistory {
  id: string;
  settingId: string;
  category: string;
  key: string;
  oldValue: any;
  newValue: any;
  changedBy: string;
  changedAt: string;
}

export interface SettingHistoryFilters {
  category?: string;
  key?: string;
  changedBy?: string;
  page?: number;
  limit?: number;
}

export interface SettingsListResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

// ─── Settings Categories ──────────────────────────────────────────────────────

export type SettingsCategory = 
  | "security"
  | "notification"
  | "behavior.telemedicine"
  | "behavior.rtc"
  | "behavior.logistics"
  | "limits"
  | "localization";

// ─── Category-specific setting keys ──────────────────────────────────────────

export type SecuritySettingKey = 
  | "max_login_attempts"
  | "lock_duration"
  | "session_expiry"
  | "token_expiry"
  | "auto_logout"
  | "require_confirmation"
  | "two_step_verification";

export type NotificationSettingKey = 
  | "user_account"
  | "global_system"
  | "new_user_registration"
  | "telemedicine"
  | "consultations"
  | "logistics_orders"
  | "logistics_all"
  | "payments"
  | "payment_gateway"
  | "payment_failed"
  | "lab_tests"
  | "prescriptions"
  | "system_maintenance"
  | "security_alerts";

export type TelemedicineSettingKey = 
  | "consultation_timeout"
  | "auto_end_inactive"
  | "auto_end_unfinished"
  | "prescription_expiry"
  | "followup_rules";

export type RTCSettingKey = 
  | "session_timeout"
  | "auto_end_inactive"
  | "reconnect_allowance"
  | "max_session_duration";

export type LogisticsSettingKey = 
  | "auto_driver_assignment_delay"
  | "reassignment_trigger_time"
  | "delivery_timeout_rules"
  | "retry_delivery_attempts";

export type LimitsSettingKey = 
  | "max_rtc_sessions_per_doctor"
  | "max_consultations_per_day"
  | "max_delivery_assignments_per_driver"
  | "max_file_upload_size"
  | "log_retention_days"
  | "api_retry_limit"
  | "event_retry_attempts"
  | "timeout_threshold";

export type LocalizationSettingKey = 
  | "default_currency"
  | "default_language"
  | "default_timezone";

export interface BatchUpdatePayload {
  settings: UpdateSettingPayload[];
}