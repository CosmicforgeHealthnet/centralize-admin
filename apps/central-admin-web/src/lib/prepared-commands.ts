"use client";

// Commands waiting for a two-person approval, kept in this browser.
//
// The approval is bound to the exact command (its command_id is the source
// operation id inside the body, and the digest covers the body), so the
// requester must later send the very same command. The approval record on
// the server holds no body; this store keeps the prepared command until it
// has been run, or the approval was rejected, revoked or has expired.
//
// Rules:
//  - one record per prepared command, scoped to the signed-in staff member;
//  - once "Run" was pressed the record is marked and Run is never offered
//    again for it (the command is never resent; its operation is read back);
//  - records whose approval can no longer be used are pruned (approvals live
//    at most 12 hours).

import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { BridgeCommandParams, OperationCommand } from "@/types/products.types";

export interface PreparedCommand {
  version: 1;
  product_id: string;
  staff_id: string;
  /** Short action label for display ("Approve app review"). */
  action_label: string;
  /** The command to run, without approval_ref. */
  command: OperationCommand<BridgeCommandParams>;
  intent_digest: string;
  /** The propose operation (its id is the approval id). */
  propose_command_id: string;
  approval_id: string | null;
  created_at: string;
  expires_at: string | null;
  /** Set once Run was pressed. The command is never sent again. */
  run: { submitted_at: string; approval_ref: string } | null;
}

const PREFIX = "hq.product-approvals.v1.";
const EVENT = "hq-prepared-commands";
/** Approval lifetime (12 h) plus a margin; unrun records older than this are useless. */
const UNRUN_MAX_AGE_MS = 13 * 3600 * 1000;
/** Ran records are kept for a week so the operation stays reachable from the case. */
const RUN_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

const keyFor = (staffId: string) => PREFIX + staffId;

function isRecord(v: unknown): v is PreparedCommand {
  const r = v as PreparedCommand;
  return !!r && r.version === 1 && typeof r.product_id === "string" && typeof r.staff_id === "string" && !!r.command && typeof r.command.command_id === "string";
}

function parse(raw: string | null): PreparedCommand[] {
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    return parsed.filter(isRecord).filter((r) => {
      const age = now - Date.parse(r.created_at);
      return r.run ? age < RUN_MAX_AGE_MS : age < UNRUN_MAX_AGE_MS;
    });
  } catch {
    return [];
  }
}

function rawOf(staffId: string): string | null {
  try {
    return window.localStorage.getItem(keyFor(staffId));
  } catch {
    return null;
  }
}

const read = (staffId: string) => parse(rawOf(staffId));

function write(staffId: string, records: PreparedCommand[]) {
  try {
    window.localStorage.setItem(keyFor(staffId), JSON.stringify(records));
  } catch {
    // Storage full or blocked: the in-memory state still works for this page.
  }
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(onChange: () => void) {
  const onStorage = (e: StorageEvent) => { if (!e.key || e.key.startsWith(PREFIX)) onChange(); };
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/** Prepared commands of one staff member for one product, with stable updaters. */
export function usePreparedCommands(productId: string, staffId: string | null | undefined) {
  const raw = useSyncExternalStore(subscribe, () => (staffId ? rawOf(staffId) : null), () => null);
  const records = useMemo(() => parse(raw).filter((r) => r.product_id === productId && r.staff_id === staffId), [raw, productId, staffId]);

  const save = useCallback((record: PreparedCommand) => {
    if (!staffId || record.staff_id !== staffId) return;
    const all = read(staffId).filter((r) => r.command.command_id !== record.command.command_id);
    write(staffId, [record, ...all]);
  }, [staffId]);

  const update = useCallback((commandId: string, patch: Partial<PreparedCommand>) => {
    if (!staffId) return;
    write(staffId, read(staffId).map((r) => (r.command.command_id === commandId ? { ...r, ...patch } : r)));
  }, [staffId]);

  const remove = useCallback((commandId: string) => {
    if (!staffId) return;
    write(staffId, read(staffId).filter((r) => r.command.command_id !== commandId));
  }, [staffId]);

  return { records, save, update, remove };
}
