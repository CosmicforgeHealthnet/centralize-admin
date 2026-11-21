"use client";

// Detail drawer for one CF Meet row: the row as listed, its detail read (when
// the module serves one), and every sub-resource and nested list addressed by
// the row's id (`parent`), each with its own state, freshness and blockers.

import { useState } from "react";
import { X } from "lucide-react";
import { Drawer, DrawerClose, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import { cn } from "@/lib/utils";
import { StateBadge } from "./CfMeetBlocked";
import { CollectionDetail, CollectionList } from "./CollectionView";
import { rowIdFor, type CfMeetScope, type ChildCollection, type ReadPurpose } from "./catalog";
import { RecordFields, type Row } from "./format";

export interface RecordDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  row: Row | null;
  /** Children of the listing collection (detail first). */
  related: ChildCollection[];
  scope: CfMeetScope;
  purpose: ReadPurpose;
}

export default function RecordDrawer({ open, onOpenChange, title, row, related, scope, purpose }: RecordDrawerProps) {
  const [tab, setTab] = useState<string>("row");
  const primary = related.find((c) => c.isPrimaryDetail) ?? null;
  const others = related.filter((c) => c !== primary);
  const primaryId = row && primary ? rowIdFor(row, primary.idField) : null;
  const anyId = row && related[0] ? rowIdFor(row, related[0].idField) : null;
  const active = others.find((c) => c.collection.id === tab) ?? null;
  const activeId = row && active ? rowIdFor(row, active.idField) : null;

  return (
    <Drawer open={open} onOpenChange={(next) => { onOpenChange(next); if (!next) setTab("row"); }} direction="right">
      <DrawerContent className="data-[vaul-drawer-direction=right]:w-full data-[vaul-drawer-direction=right]:sm:max-w-2xl">
        <DrawerHeader className="flex flex-row items-start justify-between gap-2 border-b border-border">
          <div className="min-w-0">
            <DrawerTitle>{title}</DrawerTitle>
            <DrawerDescription className="break-all font-mono text-[11px]">{primaryId ?? anyId ?? "Record"}</DrawerDescription>
          </div>
          <DrawerClose className="rounded-md p-2 text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="Close">
            <X className="h-4 w-4" aria-hidden="true" />
          </DrawerClose>
        </DrawerHeader>
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
          {row && (
            <>
              <section aria-label="Record detail" className="flex flex-col gap-2">
                <h3 className="text-[13px] font-semibold text-foreground">{primary ? "Detail" : "As listed"}</h3>
                {primary && primaryId ? (
                  <CollectionDetail collection={primary.collection} scope={scope} purpose={purpose} resourceId={primaryId} title={`${title} detail`} />
                ) : (
                  <RecordFields record={row} />
                )}
                {primary && !primaryId && <p className="text-[11px] text-muted-foreground">This row carries no usable id, so its detail cannot be read.</p>}
              </section>
              {others.length > 0 && (
                <section aria-label="Related records" className="flex flex-col gap-2">
                  <h3 className="text-[13px] font-semibold text-foreground">Related</h3>
                  <div role="tablist" aria-label="Related records" className="flex flex-wrap gap-1.5">
                    {others.map((c) => (
                      <button
                        key={c.collection.id}
                        type="button"
                        role="tab"
                        aria-selected={tab === c.collection.id}
                        onClick={() => setTab(c.collection.id)}
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px]",
                          tab === c.collection.id ? "border-primary bg-primary/10 font-semibold text-foreground" : "border-border text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {c.collection.label}
                        {!c.collection.usable && <StateBadge state={c.collection.state} />}
                      </button>
                    ))}
                  </div>
                  {active && (
                    <div role="tabpanel" aria-label={active.collection.label}>
                      {!activeId ? (
                        <p className="text-[12px] text-muted-foreground">This row carries no usable id for {active.collection.label.toLowerCase()}.</p>
                      ) : active.collection.role === "nested" ? (
                        <CollectionList key={`${active.collection.id}:${activeId}`} collection={active.collection} scope={scope} purpose={purpose} parent={activeId} />
                      ) : (
                        <CollectionDetail key={`${active.collection.id}:${activeId}`} collection={active.collection} scope={scope} purpose={purpose} resourceId={activeId} />
                      )}
                    </div>
                  )}
                </section>
              )}
            </>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  );
}
