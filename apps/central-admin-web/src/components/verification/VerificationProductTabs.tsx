"use client";

// Generalized Verification page (design §10): the HealthNet verification
// page stays exactly as it was (default tab, unchanged component); product
// tabs are added for products whose live capabilities list
// `<product>.verification.read`. Staff without such a product see the
// HealthNet page alone, with no tab bar. `?product=<id>` selects a product
// tab and `&case=<case id>` opens one case.

import { useCallback, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useProductsWithCapability } from "@/lib/products.discovery";
import { cn } from "@/lib/utils";
import { useSearchParam } from "@/lib/use-search-param";
import ProductDataState from "@/components/products/ProductDataState";
import VerificationPage from "./VerificationPage";
import ProductVerificationSection from "./products/ProductVerificationSection";

const HEALTHNET = "healthnet";
// HealthNet verification is HQ's own page; it is never duplicated as a product tab.
const EXCLUDE = [HEALTHNET];

export default function VerificationProductTabs() {
  const router = useRouter();
  const pathname = usePathname();
  const discovery = useProductsWithCapability("verification.read", { exclude: EXCLUDE });
  const urlProduct = useSearchParam("product");
  const urlCase = useSearchParam("case");
  // The URL decides until the user picks a tab or a case on this page.
  const [chosenProduct, setChosenProduct] = useState<string | null>(null);
  const [chosenCase, setChosenCase] = useState<string | null | undefined>(undefined);
  const active = chosenProduct ?? urlProduct ?? HEALTHNET;
  const caseId = chosenCase === undefined ? urlCase : chosenCase;

  const setUrl = useCallback((product: string, nextCase: string | null) => {
    const params = new URLSearchParams(window.location.search);
    if (product === HEALTHNET) params.delete("product");
    else params.set("product", product);
    if (nextCase) params.set("case", nextCase);
    else params.delete("case");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [pathname, router]);

  const entry = discovery.products.find((p) => p.product.product_id === active) ?? null;
  const showTabs = discovery.products.length > 0;

  const select = (product: string) => {
    setChosenProduct(product);
    setChosenCase(null);
    setUrl(product, null);
  };

  return (
    <div className="flex flex-col gap-3">
      {showTabs && (
        <div role="tablist" aria-label="Verification product" className="flex flex-wrap gap-1.5">
          {[{ id: HEALTHNET, label: "HealthNet" }, ...discovery.products.map((p) => ({ id: p.product.product_id, label: p.product.display_name ?? p.product.product_id }))].map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={(entry ? entry.product.product_id : HEALTHNET) === t.id}
              onClick={() => select(t.id)}
              className={cn(
                "rounded-[8px] border px-3 py-1.5 font-poppins text-[12px] transition-all",
                (entry ? entry.product.product_id : HEALTHNET) === t.id
                  ? "border-primary bg-primary font-semibold text-white"
                  : "border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
      {active !== HEALTHNET && !entry && discovery.loading ? (
        <ProductDataState title="Product verification" loading />
      ) : entry ? (
        <ProductVerificationSection
          key={entry.product.product_id}
          entry={entry}
          caseId={caseId}
          onCaseChange={(id) => { setChosenCase(id); setUrl(entry.product.product_id, id); }}
        />
      ) : (
        <VerificationPage />
      )}
    </div>
  );
}
