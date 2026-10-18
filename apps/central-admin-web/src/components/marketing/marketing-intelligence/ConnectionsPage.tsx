"use client";

import { useEffect, useState } from "react";
import { useMarketingIntelligenceStore } from "@/stores/marketing-intelligence.store";
import { getMIOAuthStartUrl } from "@/lib/marketing-intelligence.service";
import FilterBar from "../shared/FilterBar";
import DataTable, { DataTableColumn } from "../shared/DataTable";
import ProviderBadge, { BadgeProvider } from "../shared/ProviderBadge";
import StatusChip from "../shared/StatusChip";
import type { MIConnection, MIConnectionStatus, MIPlatform, MIPlatformFilter } from "@/types/marketing-intelligence.types";

// Per §6.6 — provider-specific non-secret identifier + credential fields the frontend may request.
// Never includes a field that would let the UI redisplay a saved secret.
interface CredentialField {
  key: string;
  label: string;
  placeholder?: string;
  type?: "text" | "password";
  isAccountId?: boolean;
}

const PROVIDER_CREDENTIAL_FIELDS: Record<MIPlatform, CredentialField[]> = {
  META: [
    { key: "accessToken", label: "Access Token", type: "password" },
    { key: "accountId", label: "Ad Account ID", placeholder: "act_...", isAccountId: true },
  ],
  TIKTOK: [
    { key: "appId", label: "App ID" },
    { key: "appSecret", label: "App Secret", type: "password" },
    { key: "accessToken", label: "Access Token", type: "password" },
    { key: "refreshToken", label: "Refresh Token", type: "password" },
    { key: "advertiserId", label: "Advertiser ID", isAccountId: true },
  ],
  X: [
    { key: "consumerKey", label: "Consumer Key" },
    { key: "consumerSecret", label: "Consumer Secret", type: "password" },
    { key: "accessToken", label: "Access Token", type: "password" },
    { key: "accessTokenSecret", label: "Access Token Secret", type: "password" },
    { key: "accountId", label: "Ads Account ID", isAccountId: true },
  ],
  LINKEDIN: [
    { key: "clientId", label: "Client ID" },
    { key: "clientSecret", label: "Client Secret", type: "password" },
    { key: "accessToken", label: "Access Token", type: "password" },
    { key: "refreshToken", label: "Refresh Token (if issued)", type: "password" },
    { key: "accountId", label: "Sponsored Account URN", placeholder: "urn:li:sponsoredAccount:...", isAccountId: true },
  ],
  GOOGLE_ADS: [
    { key: "clientId", label: "Client ID" },
    { key: "clientSecret", label: "Client Secret", type: "password" },
    { key: "refreshToken", label: "Refresh Token", type: "password" },
    { key: "developerToken", label: "Developer Token", type: "password" },
    { key: "accountId", label: "Customer ID", placeholder: "digits only, no dashes", isAccountId: true },
    { key: "loginCustomerId", label: "Login Customer ID (optional)" },
  ],
};

const ALL_PLATFORMS: MIPlatform[] = ["META", "TIKTOK", "X", "LINKEDIN", "GOOGLE_ADS"];

const PLATFORM_OPTIONS: { label: string; value: MIPlatformFilter }[] = [
  { label: "All platforms", value: "all" },
  { label: "Meta", value: "META" },
  { label: "TikTok", value: "TIKTOK" },
  { label: "X", value: "X" },
  { label: "LinkedIn", value: "LINKEDIN" },
  { label: "Google Ads", value: "GOOGLE_ADS" },
];

const STATUS_OPTIONS: { label: string; value: MIConnectionStatus | "" }[] = [
  { label: "All statuses", value: "" },
  { label: "Active", value: "ACTIVE" },
  { label: "Disabled", value: "DISABLED" },
  { label: "Error", value: "ERROR" },
];

// Helper to get a display label for the connection
const getAccountDisplayLabel = (connection: MIConnection): string => {
  // If there's a label from the backend, use it
  if (connection.accountLabel) return connection.accountLabel;
  
  // If there's an account ID, show it
  if (connection.accountId) return connection.accountId;
  
  // Otherwise fall back to a friendly platform name
  const platformNames: Record<MIPlatform, string> = {
    META: "Meta Ads",
    TIKTOK: "TikTok Ads",
    X: "X Ads",
    LINKEDIN: "LinkedIn Ads",
    GOOGLE_ADS: "Google Ads",
  };
  return platformNames[connection.platform] || connection.platform;
};

export default function ConnectionsPage() {
  const {
    connections, connectionFilters, setConnectionFilters, isLoadingConnections, fetchConnections,
    connectionTestResult, testConnection, enableConnection, disableConnection, deleteConnection,
    bootstrapConnections, createConnection, actionLoading, error, clearError,
  } = useMarketingIntelligenceStore();

  const [isAddOpen, setIsAddOpen] = useState(false);
  const [selectedPlatform, setSelectedPlatform] = useState<MIPlatform | null>(null);
  const [currency, setCurrency] = useState("");
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});

  const resetAddForm = () => {
    setSelectedPlatform(null);
    setCurrency("");
    setFieldValues({});
  };

  const handleCreate = async () => {
    if (!selectedPlatform) return;
    const accountIdField = PROVIDER_CREDENTIAL_FIELDS[selectedPlatform].find((f) => f.isAccountId);
    await createConnection({
      platform: selectedPlatform,
      accountId: accountIdField ? fieldValues[accountIdField.key] : undefined,
      currency: currency || undefined,
      credentials: fieldValues,
    });
    setIsAddOpen(false);
    resetAddForm();
  };

  useEffect(() => {
    fetchConnections();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (error) {
      const t = setTimeout(() => clearError(), 5000);
      return () => clearTimeout(t);
    }
  }, [error, clearError]);

  const columns: DataTableColumn<MIConnection>[] = [
    { 
      key: "platform", 
      header: "Platform", 
      render: (c) => (
        <ProviderBadge 
          provider={c.platform as BadgeProvider} 
          subtitle={getAccountDisplayLabel(c)} 
        />
      ) 
    },
    { key: "status", header: "Status", render: (c) => (
        <div className="flex flex-col gap-1 items-start">
          <StatusChip status={c.status} />
          {c.requiresReauthorization && (
            <a
              href={getMIOAuthStartUrl(c.platform.toLowerCase())}
              className="font-poppins text-[10px] font-semibold text-amber-600 underline"
            >
              Reconnect
            </a>
          )}
        </div>
      ) },
    { key: "currency", header: "Currency", render: (c) => c.currency ?? "—" },
    { key: "lastSync", header: "Last Sync", render: (c) => (
        <div className="flex flex-col">
          <span>{c.lastSyncAt ? new Date(c.lastSyncAt).toLocaleString() : "Never"}</span>
          {c.lastSyncError && <span className="text-[10px] text-red-500">{c.lastSyncError}</span>}
        </div>
      ) },
    { key: "actions", header: "Actions", render: (c) => {
        const testResult = connectionTestResult[c.id];
        const isTesting = actionLoading === `test-${c.id}`;
        const isActing = actionLoading === c.id;
        return (
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => testConnection(c.id)}
              disabled={isTesting || !c.hasRequiredCredentials}
              className="font-poppins text-[11px] font-medium text-primary disabled:opacity-40"
            >
              {isTesting ? "Testing…" : "Test"}
            </button>
            {testResult && (
              <StatusChip status={testResult} tone={testResult === "SUCCESS" ? "success" : "danger"} label={testResult === "SUCCESS" ? "Test passed" : "Test failed"} />
            )}
            {c.status === "ACTIVE" ? (
              <button onClick={() => disableConnection(c.id)} disabled={isActing} className="font-poppins text-[11px] text-muted-foreground disabled:opacity-40">
                Disable
              </button>
            ) : (
              <button onClick={() => enableConnection(c.id)} disabled={isActing || !c.hasRequiredCredentials} className="font-poppins text-[11px] text-primary disabled:opacity-40">
                Enable
              </button>
            )}
            <button onClick={() => deleteConnection(c.id)} disabled={isActing} className="font-poppins text-[11px] text-red-500 disabled:opacity-40">
              Delete
            </button>
          </div>
        );
      } },
  ];

  const activeFilterCount = (connectionFilters.platform !== "all" ? 1 : 0) + (connectionFilters.status ? 1 : 0);

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm font-poppins">
          {error}
        </div>
      )}

      <div className="flex items-center justify-between flex-wrap gap-2">
        <FilterBar
          selects={[
            { key: "platform", label: "Platform", value: connectionFilters.platform, options: PLATFORM_OPTIONS, onChange: (v) => setConnectionFilters({ platform: v as MIPlatformFilter }) },
            { key: "status", label: "Status", value: connectionFilters.status, options: STATUS_OPTIONS, onChange: (v) => setConnectionFilters({ status: v as MIConnectionStatus | "" }) },
          ]}
          activeFilterCount={activeFilterCount}
          onReset={() => setConnectionFilters({ platform: "all", status: "" })}
        />
        <div className="flex items-center gap-2">
          <button
            onClick={() => setIsAddOpen(true)}
            className="font-poppins text-[12px] font-medium bg-primary text-primary-foreground px-3.5 py-2 rounded-lg"
          >
            Add connection
          </button>
          <button
            onClick={bootstrapConnections}
            disabled={actionLoading === "bootstrap"}
            className="font-poppins text-[12px] font-medium border border-border text-foreground px-3.5 py-2 rounded-lg disabled:opacity-50"
          >
            {actionLoading === "bootstrap" ? "Importing…" : "Bootstrap from environment"}
          </button>
        </div>
      </div>

      {isAddOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-card border border-border rounded-xl w-full max-w-md max-h-[85vh] overflow-y-auto p-5 flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <p className="font-poppins text-[14px] font-semibold text-foreground">Add provider connection</p>
              <button
                onClick={() => { setIsAddOpen(false); resetAddForm(); }}
                className="font-poppins text-[12px] text-muted-foreground"
              >
                Close
              </button>
            </div>

            {/* Step 1 — select provider */}
            <div className="flex flex-col gap-1.5">
              <span className="font-poppins text-[11px] font-medium text-muted-foreground">1. Select provider</span>
              <div className="flex flex-wrap gap-2">
                {ALL_PLATFORMS.map((platform) => (
                  <button
                    key={platform}
                    onClick={() => { setSelectedPlatform(platform); setFieldValues({}); }}
                    className={`rounded-lg border p-1 ${selectedPlatform === platform ? "border-primary" : "border-border opacity-60"}`}
                  >
                    <ProviderBadge provider={platform as BadgeProvider} size="sm" />
                  </button>
                ))}
              </div>
            </div>

            {/* Step 2 — credential fields */}
            {selectedPlatform && (
              <div className="flex flex-col gap-2.5">
                <span className="font-poppins text-[11px] font-medium text-muted-foreground">
                  2. Enter connection details
                </span>
                {PROVIDER_CREDENTIAL_FIELDS[selectedPlatform].map((field) => (
                  <div key={field.key} className="flex flex-col gap-1">
                    <label className="font-poppins text-[11px] text-muted-foreground">{field.label}</label>
                    <input
                      type={field.type ?? "text"}
                      autoComplete="off"
                      placeholder={field.placeholder}
                      value={fieldValues[field.key] ?? ""}
                      onChange={(e) => setFieldValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
                      className="font-poppins text-[12px] bg-background border border-border rounded-lg px-2.5 py-1.5 text-foreground"
                    />
                  </div>
                ))}
                <div className="flex flex-col gap-1">
                  <label className="font-poppins text-[11px] text-muted-foreground">Currency</label>
                  <input
                    type="text"
                    placeholder="e.g. NGN, USD"
                    value={currency}
                    onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                    className="font-poppins text-[12px] bg-background border border-border rounded-lg px-2.5 py-1.5 text-foreground"
                  />
                </div>
              </div>
            )}

            {/* Step 3 — security notice */}
            {selectedPlatform && (
              <p className="font-poppins text-[10px] text-muted-foreground bg-muted/40 rounded-lg p-2.5">
                Credentials are encrypted at rest and will never be displayed again after saving. Creating a
                connection does not verify it — run a connection test afterward to confirm access.
              </p>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                onClick={() => { setIsAddOpen(false); resetAddForm(); }}
                className="font-poppins text-[12px] text-muted-foreground px-3 py-1.5"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={!selectedPlatform || actionLoading === "create"}
                className="font-poppins text-[12px] font-medium bg-primary text-primary-foreground px-4 py-1.5 rounded-lg disabled:opacity-50"
              >
                {actionLoading === "create" ? "Creating…" : "Create connection"}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="bg-card rounded-xl border border-border p-4">
        <DataTable
          columns={columns}
          rows={connections}
          rowKey={(c) => c.id}
          isLoading={isLoadingConnections}
          emptyLabel="No provider connections configured yet"
        />
      </div>
    </div>
  );
}