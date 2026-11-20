"use client";

// CF Meet section shell (/dashboard/cfmeet?section=...). Availability and
// scope come from GET /api/products (never from staff tier); modules,
// collections, commands and reports come from the live capabilities response.

import { useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { MfaStepUpProvider } from "@/components/products/MfaStepUp";
import ProductDataState from "@/components/products/ProductDataState";
import { useProductCapabilities, useProducts } from "@/lib/products.queries";
import { BlockedPanel } from "./CfMeetBlocked";
import CfMeetOverview from "./CfMeetOverview";
import CfMeetSubNav from "./CfMeetSubNav";
import ModuleBrowser from "./ModuleBrowser";
import ReportsPanel from "./ReportsPanel";
import ScopeSelector from "./ScopeSelector";
import { CFMEET_PRODUCT_ID, initialScope, moduleById, type CfMeetCapabilities, type CfMeetScope } from "./catalog";
import { OVERVIEW_SECTION, SECTION_IDS, sectionById } from "./sections";

const REASON_TEXT: Record<string, string> = {
  NOT_REGISTERED: "CF Meet is not registered with HQ in this environment yet.",
  NOT_ENABLED: "CF Meet is registered but not enabled (onboarding is not finished).",
};

function SectionBody({ section, caps, product, scope }: { section: string; caps: CfMeetCapabilities | undefined; product: Parameters<typeof CfMeetOverview>[0]["product"]; scope: CfMeetScope }) {
  if (section === OVERVIEW_SECTION) return <CfMeetOverview product={product} caps={caps} scope={scope} />;
  const def = sectionById(section);
  if (!def || !caps) return null;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[12px] text-muted-foreground">{def.description}</p>
      {def.modules.map((moduleId) => {
        const m = moduleById(caps, moduleId);
        return m ? (
          <ModuleBrowser key={`${def.id}:${moduleId}`} caps={caps} module={m} scope={scope} purpose={def.purpose} />
        ) : (
          <BlockedPanel key={moduleId} title={`CF Meet ${moduleId}`} state="UNAVAILABLE" blockers={[{ code: "MODULE_NOT_IN_CONTRACT", detail: "The active CF Meet capabilities list no such module." }]} />
        );
      })}
      <ReportsPanel caps={caps} reportIds={def.reports} scope={scope} purpose={def.purpose} />
    </div>
  );
}

function CfMeetContent() {
  const params = useSearchParams();
  const requested = params.get("section");
  const section = requested && SECTION_IDS.includes(requested) ? requested : OVERVIEW_SECTION;
  const label = section === OVERVIEW_SECTION ? "Overview" : sectionById(section)?.label ?? "Overview";

  const products = useProducts();
  const product = products.data?.find((p) => p.product_id === CFMEET_PRODUCT_ID) ?? null;
  const available = !!product?.available;
  const caps = useProductCapabilities<CfMeetCapabilities>(CFMEET_PRODUCT_ID, { enabled: available });
  const [scopeChoice, setScopeChoice] = useState<CfMeetScope | null>(null);
  const scope = scopeChoice ?? initialScope(product?.effective_scope);

  let body: ReactNode;
  if (products.isPending || products.error) {
    body = <ProductDataState title="CF Meet" loading={products.isPending} error={products.error} onRetry={() => products.refetch()} />;
  } else if (!product || !available) {
    const reason = product?.reason ?? "NO_PRODUCT_GRANT";
    body = (
      <BlockedPanel
        title="CF Meet"
        state={product ? "UNAVAILABLE" : "BLOCKED_POLICY"}
        blockers={[{ code: reason, detail: REASON_TEXT[reason] ?? (product ? "CF Meet is not available right now." : "You hold no CF Meet product grant.") }]}
      />
    );
  } else {
    body = (
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3 rounded-xl border border-border bg-card p-4">
          <ScopeSelector effective={product.effective_scope} value={scope} onChange={setScopeChoice} />
          {product.role && <p className="text-[11px] text-muted-foreground">Role <span className="font-mono">{product.role}</span></p>}
        </div>
        {section !== OVERVIEW_SECTION && (caps.isPending || caps.error) ? (
          <ProductDataState title="CF Meet capabilities" loading={caps.isPending} error={caps.error} onRetry={() => caps.refetch()} />
        ) : (
          <SectionBody section={section} caps={caps.data?.result} product={product} scope={scope} />
        )}
        {section === OVERVIEW_SECTION && (caps.isPending || !!caps.error) && (
          <ProductDataState title="CF Meet modules" loading={caps.isPending} error={caps.error} onRetry={() => caps.refetch()} />
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 min-[1014px]:flex-row min-[1014px]:gap-6">
      <CfMeetSubNav active={section} />
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <header className="flex flex-col gap-1">
          <h1 className="font-poppins text-[20px] font-semibold text-foreground">CF Meet · {label}</h1>
          <p className="text-[12px] text-muted-foreground">Read-only views served by CF Meet Admin. Every figure shows when it was observed, how fresh it is and how complete.</p>
        </header>
        {body}
      </div>
    </div>
  );
}

export default function CfMeetSection() {
  return (
    <MfaStepUpProvider>
      <CfMeetContent />
    </MfaStepUpProvider>
  );
}
