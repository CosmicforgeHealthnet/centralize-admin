"use client";

// Catalog-driven browser of one CF Meet Product Admin module: its top-level
// collections (each with its exposure state), the selected collection's list,
// a detail drawer with nested lists, id lookups for collections that have no
// list parent, and the module's commands (state and blockers only; actions
// come with the approvals flow).

import { useMemo, useState, type FormEvent } from "react";
import { cn } from "@/lib/utils";
import { BlockedPanel, BlockerList, StateBadge } from "./CfMeetBlocked";
import { CollectionDetail, CollectionList } from "./CollectionView";
import ModuleCommands from "./ModuleCommands";
import RecordDrawer from "./RecordDrawer";
import {
  RESOURCE_ID,
  capabilityById,
  childCollections,
  isUsableState,
  moduleCollections,
  orphanCollections,
  type CfMeetCapabilities,
  type CfMeetModuleSummary,
  type CfMeetScope,
  type CollectionModel,
  type ReadPurpose,
} from "./catalog";
import type { Row } from "./format";

function IdLookup({ collection, scope, purpose }: { collection: CollectionModel; scope: CfMeetScope; purpose: ReadPurpose }) {
  const [draft, setDraft] = useState("");
  const [id, setId] = useState<string | null>(null);
  const field = collection.pathParams[0] ?? "id";
  const invalid = draft.trim() !== "" && !RESOURCE_ID.test(draft.trim());
  const inputId = `cfmeet-lookup-${collection.id.replaceAll(".", "-")}`;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!invalid && draft.trim()) setId(draft.trim());
  };
  if (!collection.usable) return <BlockedPanel title={collection.label} state={collection.state} blockers={collection.blockers} compact />;
  return (
    <div className="flex flex-col gap-3">
      <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-[220px] flex-1 flex-col gap-1">
          <label htmlFor={inputId} className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{field.replaceAll("_", " ")}</label>
          <input id={inputId} value={draft} maxLength={128} onChange={(e) => setDraft(e.target.value)} className="rounded-md border border-border bg-card px-2 py-1.5 font-mono text-[12px]" />
        </div>
        <button type="submit" disabled={invalid || !draft.trim()} className="rounded-md border border-border px-3 py-1.5 text-[12px] font-semibold hover:bg-muted disabled:opacity-50">Look up</button>
        {invalid && <p role="alert" className="w-full text-[11px] text-amber-700 dark:text-amber-400">Ids use letters, digits and . _ : - only.</p>}
      </form>
      {id &&
        (collection.role === "nested" ? (
          <CollectionList key={id} collection={collection} scope={scope} purpose={purpose} parent={id} />
        ) : (
          <CollectionDetail key={id} collection={collection} scope={scope} purpose={purpose} resourceId={id} />
        ))}
    </div>
  );
}

export interface ModuleBrowserProps {
  caps: CfMeetCapabilities;
  module: CfMeetModuleSummary;
  scope: CfMeetScope;
  purpose: ReadPurpose;
}

export default function ModuleBrowser({ caps, module, scope, purpose }: ModuleBrowserProps) {
  const collections = useMemo(() => moduleCollections(caps, module), [caps, module]);
  const topLevel = collections.filter((c) => c.role === "list" || c.role === "single" || c.role === "unsupported");
  const orphans = useMemo(() => orphanCollections(collections), [collections]);
  const entries = [...topLevel.map((c) => ({ key: c.id, collection: c, lookup: false })), ...orphans.map((c) => ({ key: `lookup:${c.id}`, collection: c, lookup: true }))];
  const firstUsable = entries.find((e) => e.collection.usable) ?? entries[0];
  const [selected, setSelected] = useState<string | null>(null);
  const current = entries.find((e) => e.key === selected) ?? firstUsable ?? null;
  const [openRow, setOpenRow] = useState<Row | null>(null);
  const related = current && !current.lookup ? childCollections(current.collection, collections) : [];
  const readCap = capabilityById(caps, module.read_capability_id);
  const readState = readCap?.state ?? "UNAVAILABLE";
  const usableCount = collections.filter((c) => c.usable).length;

  return (
    <section aria-label={module.title} className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[15px] font-semibold text-foreground">{module.title}</h2>
          <StateBadge state={readState} />
          <span className="text-[11px] text-muted-foreground">
            {usableCount} of {collections.length} collections readable · purpose <span className="font-mono">{purpose}</span>
          </span>
        </div>
        {readCap && !isUsableState(readState) && <BlockerList blockers={readCap.blockers} />}
        {module.rules.length > 0 && (
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
            {module.rules.map((r) => (
              <li key={r}>· {r}</li>
            ))}
          </ul>
        )}
      </header>

      {entries.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">This module serves no collections in the active contract.</p>
      ) : (
        <>
          <div role="tablist" aria-label={`${module.title} collections`} className="flex flex-wrap gap-1.5">
            {entries.map((e) => {
              const on = current?.key === e.key;
              return (
                <button
                  key={e.key}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  data-collection={e.collection.id}
                  onClick={() => { setSelected(e.key); setOpenRow(null); }}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px]",
                    on ? "border-primary bg-primary/10 font-semibold text-foreground" : "border-border text-muted-foreground hover:text-foreground",
                  )}
                >
                  {e.lookup ? `${e.collection.label} (by id)` : e.collection.label}
                  {!e.collection.usable && <StateBadge state={e.collection.state} />}
                </button>
              );
            })}
          </div>
          {current && (
            <div role="tabpanel" aria-label={current.collection.label} className="flex flex-col gap-2">
              <p className="font-mono text-[10px] text-muted-foreground">{current.collection.id}</p>
              {current.lookup ? (
                <IdLookup key={current.key} collection={current.collection} scope={scope} purpose={purpose} />
              ) : (
                <CollectionList
                  key={current.key}
                  collection={current.collection}
                  scope={scope}
                  purpose={purpose}
                  onOpenRow={related.length > 0 || current.collection.role === "list" ? setOpenRow : undefined}
                />
              )}
            </div>
          )}
        </>
      )}

      <ModuleCommands caps={caps} moduleId={module.module} />

      {current && !current.lookup && (
        <RecordDrawer
          open={openRow !== null}
          onOpenChange={(o) => { if (!o) setOpenRow(null); }}
          title={current.collection.label}
          row={openRow}
          related={related}
          scope={scope}
          purpose={purpose}
        />
      )}
    </section>
  );
}
