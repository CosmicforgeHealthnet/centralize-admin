"use client";

// Approvals inbox (design §10): two-person approvals of every product that
// exposes `<product>.governance.read` (CF Meet today).
//   - "Waiting for me": approvals-pending, approvals this staff member could
//     decide now (never their own);
//   - "My requests": approvals-mine, their own requests in any status.
// Reads need market, organization and purpose (zone/tenant optional) and a
// recent MFA; deciding and revoking go through POST /operations.

import { useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { MfaStepUpProvider } from "@/components/products/MfaStepUp";
import ProductDataState, { RefreshButton } from "@/components/products/ProductDataState";
import ServiceDataState from "@/components/shared/ServiceDataState";
import { useProductResourcesInfinite } from "@/lib/products.queries";
import { useProductsWithCapability, useScopeSelection } from "@/lib/products.discovery";
import { qualityOf } from "@/lib/products.service";
import { READ_PURPOSES, type ApprovalItem, type ApprovalListData } from "@/lib/product-approvals";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth.store";
import { useSearchParam } from "@/lib/use-search-param";
import type { ProductWithCapability } from "@/lib/products.discovery";
import ApprovalCard from "./ApprovalCard";
import ApprovalDetail from "./ApprovalDetail";
import CapabilityNotice, { capabilityUsable } from "./CapabilityNotice";
import ScopeBar from "./ScopeBar";

type Tab = "pending" | "mine";
const TABS: { id: Tab; label: string; collection: string; empty: string }[] = [
  { id: "pending", label: "Waiting for me", collection: "approvals-pending", empty: "Nothing is waiting for your decision in this scope." },
  { id: "mine", label: "My requests", collection: "approvals-mine", empty: "You have not requested any approvals in this scope." },
];

function ProductInbox({ entry, tab, onTab, staffId }: { entry: ProductWithCapability; tab: Tab; onTab: (t: Tab) => void; staffId: string | null }) {
  const productId = entry.product.product_id;
  const scope = useScopeSelection(entry.product.effective_scope, false);
  const [purpose, setPurpose] = useState<string>("verification-review");
  const [selected, setSelected] = useState<ApprovalItem | null>(null);
  const active = TABS.find((t) => t.id === tab) ?? TABS[0];
  const usable = capabilityUsable(entry.capability);
  const query = { ...scope.value, market: scope.value.market ?? "", organization: scope.value.organization ?? "", purpose };
  const list = useProductResourcesInfinite<ApprovalListData>(productId, entry.capability.id, active.collection, { ...query, limit: 25 }, { enabled: usable && scope.complete });
  const pages = list.data?.pages ?? [];
  const items = pages.flatMap((p) => p.result.data?.items ?? []);

  if (!usable) return <CapabilityNotice title="Approvals" capability={entry.capability} />;

  return (
    <div className="flex flex-col gap-4">
      <ScopeBar
        effective={entry.product.effective_scope}
        value={scope.value}
        onChange={(dim, v) => { scope.set(dim, v); setSelected(null); }}
        purpose={purpose}
        purposes={READ_PURPOSES}
        onPurposeChange={(p) => { setPurpose(p); setSelected(null); }}
      />

      {selected ? (
        <ApprovalDetail
          key={selected.approval_id}
          productId={productId}
          item={selected}
          query={query}
          staffId={staffId}
          onBack={() => setSelected(null)}
        />
      ) : (
        <>
          <div className="flex items-center justify-between gap-2">
            <div role="tablist" aria-label="Approvals" className="flex gap-1 rounded-md bg-muted/50 p-1">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  id={`approvals-tab-${t.id}`}
                  aria-selected={t.id === active.id}
                  aria-controls="approvals-panel"
                  onClick={() => onTab(t.id)}
                  className={cn(
                    "rounded-[6px] px-3 py-1.5 font-poppins text-[12px] transition-colors",
                    t.id === active.id ? "bg-card font-semibold text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <RefreshButton onClick={() => void list.refetch()} busy={list.isFetching} label="Refresh approvals" />
          </div>

          <div role="tabpanel" id="approvals-panel" aria-labelledby={`approvals-tab-${active.id}`} className="flex flex-col gap-3">
            {!scope.complete ? (
              <ServiceDataState empty title="Choose a scope" message="Select the market and organization to see approvals." compact />
            ) : (
              <ProductDataState
                title="Approvals"
                loading={list.isPending}
                error={list.error}
                onRetry={() => list.refetch()}
                empty={!!list.data && items.length === 0}
                emptyMessage={active.empty}
                quality={pages[0] ? qualityOf(pages[0]) : null}
              >
                <span className="font-poppins text-[11px] text-muted-foreground">
                  {items.length} {items.length === 1 ? "approval" : "approvals"}{list.hasNextPage ? " (more available)" : ""}
                </span>
                <ul className="flex flex-col gap-3">
                  {items.map((item) => (
                    <li key={item.approval_id}>
                      <ApprovalCard item={item} staffId={staffId} onOpen={setSelected} />
                    </li>
                  ))}
                </ul>
                {list.hasNextPage && (
                  <button
                    type="button"
                    onClick={() => void list.fetchNextPage()}
                    disabled={list.isFetchingNextPage}
                    className="self-center rounded-md border border-border px-3 py-1.5 font-poppins text-[12px] font-medium text-foreground hover:bg-muted disabled:opacity-60"
                  >
                    {list.isFetchingNextPage ? "Loading…" : "Load more"}
                  </button>
                )}
              </ProductDataState>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default function ApprovalsInboxPage() {
  const router = useRouter();
  const pathname = usePathname();
  const staffId = useAuthStore((s) => (s.user?.id ? String(s.user.id) : null));
  const discovery = useProductsWithCapability("governance.read");
  const urlTab = useSearchParam("tab");
  const urlProduct = useSearchParam("product");
  // The URL decides until the user picks a tab or product on this page.
  const [chosenTab, setTab] = useState<Tab | null>(null);
  const [chosenProduct, setProductId] = useState<string | null>(null);
  const tab: Tab = chosenTab ?? (urlTab === "mine" ? "mine" : "pending");
  const productId = chosenProduct ?? urlProduct;

  const entry = useMemo(
    () => discovery.products.find((p) => p.product.product_id === productId) ?? discovery.products[0] ?? null,
    [discovery.products, productId],
  );

  const navigate = (next: { tab?: Tab; product?: string }) => {
    const params = new URLSearchParams(window.location.search);
    if (next.tab) params.set("tab", next.tab);
    if (next.product) params.set("product", next.product);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  return (
    <MfaStepUpProvider description="Approvals need a recent confirmation. Enter the 6-digit code from your authenticator app.">
      <div className="flex flex-col gap-4 rounded-[12px] border border-border bg-card p-4 sm:p-5">
        <div>
          <h1 className="font-poppins text-[15px] font-semibold text-foreground">Approvals</h1>
          <p className="mt-0.5 font-poppins text-[12px] text-muted-foreground">
            Two-person approvals for product actions. You never decide your own requests.
          </p>
        </div>

        {discovery.products.length > 1 && (
          <div role="tablist" aria-label="Product" className="flex flex-wrap gap-1.5">
            {discovery.products.map((p) => (
              <button
                key={p.product.product_id}
                type="button"
                role="tab"
                aria-selected={entry?.product.product_id === p.product.product_id}
                onClick={() => { setProductId(p.product.product_id); navigate({ product: p.product.product_id }); }}
                className={cn(
                  "rounded-[8px] border px-3 py-1.5 font-poppins text-[12px]",
                  entry?.product.product_id === p.product.product_id ? "border-primary bg-primary text-white" : "border-border bg-card text-muted-foreground hover:text-foreground",
                )}
              >
                {p.product.display_name ?? p.product.product_id}
              </button>
            ))}
          </div>
        )}

        {discovery.loading ? (
          <ProductDataState title="Products" loading />
        ) : discovery.productsQuery.error ? (
          <ProductDataState title="Products" error={discovery.productsQuery.error} onRetry={() => discovery.productsQuery.refetch()} />
        ) : !entry ? (
          <ServiceDataState
            empty
            title="No product approvals"
            message={discovery.failed.length ? `Product capabilities could not be read for: ${discovery.failed.join(", ")}.` : "None of your products offers two-person approvals."}
          />
        ) : (
          <ProductInbox
            key={entry.product.product_id}
            entry={entry}
            tab={tab}
            onTab={(t) => { setTab(t); navigate({ tab: t }); }}
            staffId={staffId}
          />
        )}
      </div>
    </MfaStepUpProvider>
  );
}
