"use client";

// M8: HQ administration of product integrations (Karryam, HealthNet, ...).
// Shows status, contract version, allowed events, authorized senders,
// product-isolated health and recent events. Secrets are never shown: the
// API only says whether the service credential is configured server-side.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import PermissionBoundary from "@/components/mail/PermissionBoundary";
import StepUpDialog from "@/components/marketing/email-marketing/StepUpDialog";
import { formatFullDate } from "@/components/mail/mail-utils";
import { classifyMailError } from "@/lib/mail.service";
import {
  activateIntegration,
  authorizeIntegrationSender,
  createIntegration,
  integrationEvents,
  integrationHealth,
  integrationSenders,
  listIntegrations,
  listMailOrganizations,
  listOrganizationAddresses,
  revokeIntegrationSender,
  suspendIntegration,
} from "@/lib/mail-integrations.service";
import type { ProductIntegration, SenderPurpose } from "@/types/mail-integrations.types";

const card = "rounded-lg border border-border bg-card p-4";
const input = "w-full rounded-md border border-border bg-card px-3 py-2 text-[12px] outline-none focus:border-primary";
const btn = "rounded-md bg-primary px-3 py-1.5 text-[12px] font-semibold text-primary-foreground disabled:opacity-50";
const ghost = "rounded-md border border-border px-3 py-1.5 text-[12px] font-semibold disabled:opacity-50";

const keys = {
  list: ["mail", "integrations"] as const,
  health: (id: string) => ["mail", "integrations", id, "health"] as const,
  senders: (id: string) => ["mail", "integrations", id, "senders"] as const,
  events: (id: string, status: string) => ["mail", "integrations", id, "events", status] as const,
};

const STATUS_TONE: Record<string, string> = {
  ACTIVE: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  SUSPENDED: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200",
  DISABLED: "bg-muted text-muted-foreground",
};

const WARNING_TEXT: Record<string, string> = {
  NO_EVENTS_IN_24H: "No events received in the last 24 hours.",
  CREDENTIAL_NOT_CONFIGURED: "The service credential is not configured on the server. Events will be rejected.",
};

function Pill({ value }: { value: string }) {
  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${STATUS_TONE[value] ?? "bg-muted"}`}>{value}</span>;
}

function CreateIntegration({ onCreated }: { onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const orgs = useQuery({ queryKey: ["mail", "admin", "organizations"], queryFn: listMailOrganizations, retry: false });
  const [product, setProduct] = useState("");
  const [serviceName, setServiceName] = useState("");
  const [organizationId, setOrganizationId] = useState("");
  const [events, setEvents] = useState<string[]>(["mail.delivery_status", "ops.alert"]);
  const [msg, setMsg] = useState<string | null>(null);
  const health = product.trim().toLowerCase().startsWith("healthnet");
  const effectiveEvents = health ? ["ops.alert"] : events;
  const create = useMutation({
    mutationFn: () => createIntegration({ product: product.trim().toLowerCase(), serviceName: serviceName.trim(), organizationId, allowedEventTypes: effectiveEvents, allowedTriggerTypes: [] }),
    onSuccess: (row) => {
      setMsg("Integration created. It stays disabled until the product owner approves activation.");
      qc.invalidateQueries({ queryKey: keys.list });
      onCreated(row.id);
    },
    onError: (e) => setMsg(classifyMailError(e).message),
  });
  const toggle = (type: string) => setEvents((list) => (list.includes(type) ? list.filter((t) => t !== type) : [...list, type]));
  return (
    <section className={card} aria-labelledby="int-new-h">
      <h2 id="int-new-h" className="mb-2 text-[13px] font-semibold">Register a product integration</h2>
      <form className="grid grid-cols-1 gap-2 sm:grid-cols-3" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <label className="text-[11px] text-muted-foreground">Product
          <input value={product} onChange={(e) => setProduct(e.target.value)} className={input} placeholder="karryam" required />
        </label>
        <label className="text-[11px] text-muted-foreground">Service identity
          <input value={serviceName} onChange={(e) => setServiceName(e.target.value)} className={input} placeholder="karryam-notification-service" required />
        </label>
        <label className="text-[11px] text-muted-foreground">Brand organization
          <select value={organizationId} onChange={(e) => setOrganizationId(e.target.value)} className={input} required>
            <option value="">Select…</option>
            {(orgs.data ?? []).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </label>
        <fieldset className="sm:col-span-3 text-[11px] text-muted-foreground">
          <legend>Allowed events (contract v1)</legend>
          {["mail.delivery_status", "marketing.trigger", "ops.alert"].map((type) => (
            <label key={type} className="mr-4 inline-flex items-center gap-1">
              <input type="checkbox" checked={effectiveEvents.includes(type)} disabled={health} onChange={() => toggle(type)} /> {type}
            </label>
          ))}
          {health && <p className="mt-1">HealthNet integrations are restricted: operational alerts only, with no personal or clinical data.</p>}
        </fieldset>
        <button type="submit" className={`${btn} justify-self-start`} disabled={create.isPending || !product.trim() || !serviceName.trim() || !organizationId}>Register (disabled)</button>
      </form>
      {msg && <p role="status" className="mt-1 text-[11px] text-muted-foreground">{msg}</p>}
    </section>
  );
}

function Activation({ integration }: { integration: ProductIntegration }) {
  const qc = useQueryClient();
  const [reference, setReference] = useState("");
  const [approver, setApprover] = useState("");
  const [reason, setReason] = useState("");
  const [stepUp, setStepUp] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["mail", "integrations"] });
  const suspend = useMutation({
    mutationFn: () => suspendIntegration(integration.id, reason.trim()),
    onSuccess: () => { setMsg("Integration suspended. New events are rejected."); refresh(); },
    onError: (e) => setMsg(classifyMailError(e).message),
  });
  return (
    <div className="mt-3 border-t border-border pt-3">
      {integration.status !== "ACTIVE" ? (
        <form className="grid grid-cols-1 gap-2 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); setStepUp(true); }}>
          <p className="sm:col-span-2 text-[11px] text-muted-foreground">Activation records the product owner&apos;s written approval and needs MFA. Do not activate before the product owner has tested the integration in a non-production environment.</p>
          <label className="text-[11px] text-muted-foreground">Owner approval reference
            <input value={reference} onChange={(e) => setReference(e.target.value)} className={input} placeholder="Ticket or document ID" required minLength={3} />
          </label>
          <label className="text-[11px] text-muted-foreground">Approved by (product owner)
            <input value={approver} onChange={(e) => setApprover(e.target.value)} className={input} required minLength={3} />
          </label>
          <button type="submit" className={`${btn} justify-self-start`} disabled={reference.trim().length < 3 || approver.trim().length < 3}>Activate…</button>
        </form>
      ) : (
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); suspend.mutate(); }}>
          <label className="flex-1 text-[11px] text-muted-foreground">Suspension reason
            <input value={reason} onChange={(e) => setReason(e.target.value)} className={input} required />
          </label>
          <button type="submit" className={ghost} disabled={!reason.trim() || suspend.isPending}>Suspend</button>
        </form>
      )}
      {msg && <p role="status" className="mt-1 text-[11px] text-muted-foreground">{msg}</p>}
      {stepUp && (
        <StepUpDialog
          purpose="MAIL_INTEGRATION_ACTIVATE"
          title={`Activate ${integration.product} integration`}
          onCancel={() => setStepUp(false)}
          onVerified={async (stepUpId) => {
            setStepUp(false);
            try {
              await activateIntegration(integration.id, { ownerApprovalReference: reference.trim(), ownerApprovedBy: approver.trim(), stepUpId });
              setMsg("Integration activated.");
              refresh();
            } catch (e) {
              setMsg(classifyMailError(e).message);
            }
          }}
        />
      )}
    </div>
  );
}

function Senders({ integration }: { integration: ProductIntegration }) {
  const qc = useQueryClient();
  const senders = useQuery({ queryKey: keys.senders(integration.id), queryFn: () => integrationSenders(integration.id), retry: false });
  const addresses = useQuery({ queryKey: ["mail", "admin", "addresses", integration.organization.id], queryFn: () => listOrganizationAddresses(integration.organization.id), retry: false });
  const restricted = integration.classification === "RESTRICTED_HEALTH";
  const [addressId, setAddressId] = useState("");
  const [purpose, setPurpose] = useState<SenderPurpose>(restricted ? "OPERATIONAL_ALERT" : "TRANSACTIONAL");
  const [msg, setMsg] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: keys.senders(integration.id) });
  const add = useMutation({
    mutationFn: () => authorizeIntegrationSender(integration.id, addressId, purpose),
    onSuccess: () => { setMsg("Sender authorized."); setAddressId(""); refresh(); },
    onError: (e) => setMsg(classifyMailError(e).message),
  });
  const revoke = useMutation({
    mutationFn: (senderId: string) => revokeIntegrationSender(integration.id, senderId),
    onSuccess: () => { setMsg("Sender revoked."); refresh(); },
    onError: (e) => setMsg(classifyMailError(e).message),
  });
  const eligible = (addresses.data ?? []).filter((a) => a.status === "ACTIVE" && ["SYSTEM", "SHARED", "ALIAS"].includes(a.kind));
  return (
    <section className={card} aria-labelledby="int-senders-h">
      <h3 id="int-senders-h" className="mb-2 text-[13px] font-semibold">Authorized senders</h3>
      <p className="mb-2 text-[11px] text-muted-foreground">Delivery reports are accepted only for these brand identities. The product keeps sending its own transactional mail; HQ never sends it.</p>
      <PermissionBoundary isLoading={senders.isLoading} error={senders.error} compact>
        <ul className="text-[12px]">
          {(senders.data ?? []).length === 0 && <li className="text-muted-foreground">No senders authorized.</li>}
          {(senders.data ?? []).map((s) => (
            <li key={s.id} className="flex items-center gap-2 border-t border-border py-1">
              <span className="flex-1">{s.address}</span>
              <span className="text-muted-foreground">{s.purpose}</span>
              {s.active ? (
                <button type="button" className={ghost} disabled={revoke.isPending} onClick={() => revoke.mutate(s.id)} aria-label={`Revoke ${s.address}`}>Revoke</button>
              ) : (
                <span className="text-muted-foreground">Revoked {s.revokedAt ? formatFullDate(s.revokedAt) : ""}</span>
              )}
            </li>
          ))}
        </ul>
      </PermissionBoundary>
      <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (addressId) add.mutate(); }}>
        <label className="flex-1 text-[11px] text-muted-foreground">Brand identity
          <select value={addressId} onChange={(e) => setAddressId(e.target.value)} className={input}>
            <option value="">Select…</option>
            {eligible.map((a) => <option key={a.id} value={a.id}>{a.address}</option>)}
          </select>
        </label>
        <label className="text-[11px] text-muted-foreground">Purpose
          <select value={purpose} onChange={(e) => setPurpose(e.target.value as SenderPurpose)} className={input} disabled={restricted}>
            <option value="TRANSACTIONAL">Transactional</option>
            <option value="MARKETING_TRIGGER">Marketing trigger</option>
            <option value="OPERATIONAL_ALERT">Operational alert</option>
          </select>
        </label>
        <button type="submit" className={btn} disabled={!addressId || add.isPending}>Authorize</button>
      </form>
      {msg && <p role="status" className="mt-1 text-[11px] text-muted-foreground">{msg}</p>}
    </section>
  );
}

function Health({ integration }: { integration: ProductIntegration }) {
  const health = useQuery({ queryKey: keys.health(integration.id), queryFn: () => integrationHealth(integration.id), retry: false, refetchInterval: 60_000 });
  const [status, setStatus] = useState("");
  const events = useQuery({ queryKey: keys.events(integration.id, status), queryFn: () => integrationEvents(integration.id, status || undefined), retry: false });
  const data = health.data;
  return (
    <section className={card} aria-labelledby="int-health-h">
      <h3 id="int-health-h" className="mb-2 text-[13px] font-semibold">Health</h3>
      <PermissionBoundary isLoading={health.isLoading} error={health.error} compact>
        {data && (
          <div className="flex flex-col gap-2 text-[12px]">
            {data.warnings.map((w) => <p key={w} role="alert" className="rounded bg-amber-100 px-2 py-1 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100">{WARNING_TEXT[w] ?? w}</p>)}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {["DELIVERED", "BOUNCED", "COMPLAINED", "FAILED"].map((s) => (
                <div key={s} className="rounded border border-border p-2">
                  <p className="text-[10px] text-muted-foreground">{s} (24h / 7d)</p>
                  <p className="font-semibold">{data.delivery24h[s] ?? 0} / {data.delivery7d[s] ?? 0}</p>
                </div>
              ))}
            </div>
            <div>
              <p className="text-[11px] font-semibold text-muted-foreground">Rejections (7d)</p>
              {data.rejections7d.length === 0 ? <p className="text-muted-foreground">None.</p> : (
                <ul>{data.rejections7d.map((r) => <li key={r.code ?? "none"}>{r.code ?? "UNKNOWN"}: {r.count}</li>)}</ul>
              )}
            </div>
          </div>
        )}
      </PermissionBoundary>
      <div className="mt-3">
        <label className="text-[11px] text-muted-foreground">Recent events
          <select value={status} onChange={(e) => setStatus(e.target.value)} className={`${input} mt-1 max-w-[200px]`}>
            <option value="">All</option>
            <option value="ACCEPTED">Accepted</option>
            <option value="REJECTED">Rejected</option>
          </select>
        </label>
        <PermissionBoundary isLoading={events.isLoading} error={events.error} compact>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left text-[11px]">
              <thead><tr className="text-muted-foreground"><th className="py-1">Received</th><th>Type</th><th>Status</th><th>Error</th><th>Correlation</th></tr></thead>
              <tbody>
                {(events.data ?? []).length === 0 && <tr><td colSpan={5} className="py-1 text-muted-foreground">No events.</td></tr>}
                {(events.data ?? []).map((e) => (
                  <tr key={e.id} className="border-t border-border">
                    <td className="py-1">{formatFullDate(e.receivedAt)}</td>
                    <td>{e.eventType}@{e.eventVersion}</td>
                    <td>{e.status}</td>
                    <td>{e.errorCode ?? "—"}</td>
                    <td className="max-w-[160px] truncate">{e.correlationId ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </PermissionBoundary>
      </div>
    </section>
  );
}

export default function IntegrationsAdmin() {
  const list = useQuery({ queryKey: keys.list, queryFn: listIntegrations, retry: false });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const rows = list.data ?? [];
  const selected = rows.find((r) => r.id === selectedId) ?? rows[0];
  return (
    <div className="flex flex-col gap-4">
      <PermissionBoundary isLoading={list.isLoading} error={list.error} retry={() => list.refetch()} forbiddenMessage="Only mail administrators (or holders of a product integration view grant) can see product integrations.">
        <section className={card} aria-labelledby="int-list-h">
          <h2 id="int-list-h" className="mb-2 text-[13px] font-semibold">Product integrations</h2>
          {rows.length === 0 ? <p className="text-[12px] text-muted-foreground">No product integrations registered.</p> : (
            <ul className="text-[12px]" role="listbox" aria-label="Integrations">
              {rows.map((r) => (
                <li key={r.id} role="option" aria-selected={selected?.id === r.id}>
                  <button type="button" onClick={() => setSelectedId(r.id)} className={`flex w-full items-center gap-2 border-t border-border py-1.5 text-left ${selected?.id === r.id ? "font-semibold" : ""}`}>
                    <span className="w-28">{r.product}</span>
                    <span className="flex-1 text-muted-foreground">{r.serviceName}</span>
                    {r.classification === "RESTRICTED_HEALTH" && <span className="text-[10px] text-muted-foreground">restricted</span>}
                    <Pill value={r.status} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        {selected && (
          <>
            <section className={card} aria-labelledby="int-detail-h">
              <h2 id="int-detail-h" className="mb-2 text-[13px] font-semibold">{selected.product} · {selected.organization.name ?? selected.organization.id}</h2>
              <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-[12px] sm:grid-cols-2">
                <div><dt className="text-[10px] text-muted-foreground">Status</dt><dd><Pill value={selected.status} /></dd></div>
                <div><dt className="text-[10px] text-muted-foreground">Contract version</dt><dd>v{selected.contractVersion}</dd></div>
                <div><dt className="text-[10px] text-muted-foreground">Service identity</dt><dd>{selected.serviceName}</dd></div>
                <div><dt className="text-[10px] text-muted-foreground">Credential</dt><dd>{selected.credentialConfigured ? "Configured on server" : "Not configured"}</dd></div>
                <div><dt className="text-[10px] text-muted-foreground">Allowed events</dt><dd>{selected.allowedEventTypes.join(", ") || "—"}</dd></div>
                <div><dt className="text-[10px] text-muted-foreground">Allowed triggers</dt><dd>{selected.allowedTriggerTypes.join(", ") || "—"}</dd></div>
                <div><dt className="text-[10px] text-muted-foreground">Owner approval</dt><dd>{selected.ownerApprovalReference ? `${selected.ownerApprovalReference} (${selected.ownerApprovedBy})` : "Not approved"}</dd></div>
                <div><dt className="text-[10px] text-muted-foreground">Last event / last error</dt><dd>{selected.lastEventAt ? formatFullDate(selected.lastEventAt) : "—"} / {selected.lastErrorCode ?? "—"}</dd></div>
              </dl>
              <Activation key={`act-${selected.id}-${selected.status}`} integration={selected} />
            </section>
            <Senders key={`snd-${selected.id}`} integration={selected} />
            <Health key={`hl-${selected.id}`} integration={selected} />
          </>
        )}
        <CreateIntegration onCreated={setSelectedId} />
      </PermissionBoundary>
    </div>
  );
}
