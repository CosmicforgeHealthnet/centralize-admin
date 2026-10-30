// M8 product integration administration (HQ Mail). No secrets are ever
// returned by the API; `credentialConfigured` only says whether the service
// identity has a secret in the server environment.

export type IntegrationStatus = "DISABLED" | "ACTIVE" | "SUSPENDED";
export type IntegrationClassification = "STANDARD" | "RESTRICTED_HEALTH";
export type SenderPurpose = "TRANSACTIONAL" | "MARKETING_TRIGGER" | "OPERATIONAL_ALERT";

export interface ProductIntegration {
  id: string;
  product: string;
  organization: { id: string; slug?: string; name?: string };
  serviceName: string;
  status: IntegrationStatus;
  classification: IntegrationClassification;
  contractVersion: number;
  allowedEventTypes: string[];
  allowedTriggerTypes: string[];
  ownerApprovalReference: string | null;
  ownerApprovedBy: string | null;
  approvedAt: string | null;
  lastEventAt: string | null;
  lastErrorCode: string | null;
  lastErrorAt: string | null;
  credentialConfigured: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface IntegrationSender {
  id: string;
  addressId: string;
  address: string;
  purpose: SenderPurpose;
  active: boolean;
  createdAt: string;
  revokedAt: string | null;
}

export interface IntegrationHealth {
  integration: ProductIntegration;
  events24h: { eventType: string; status: string; count: number }[];
  rejections7d: { code: string | null; count: number }[];
  delivery24h: Record<string, number>;
  delivery7d: Record<string, number>;
  deliveryByCategory7d: { category: string; status: string; count: number }[];
  warnings: string[];
}

export interface IntegrationEvent {
  id: string;
  eventId: string | null;
  eventType: string;
  eventVersion: number;
  correlationId: string | null;
  status: string;
  errorCode: string | null;
  outcome: unknown;
  occurredAt: string | null;
  receivedAt: string;
}

export interface MailOrganizationRef { id: string; slug: string; name: string }
export interface MailAddressRef { id: string; address: string; kind: string; status: string; organizationId: string }
