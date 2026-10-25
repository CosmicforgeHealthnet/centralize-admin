"use client";

import { Suspense } from "react";

import EmailMarketingShell from "@/components/marketing/email-marketing/EmailMarketingShell";
import BrandSettingsPanel from "@/components/marketing/email-marketing/BrandSettingsPanel";

function Inner() {

  return <EmailMarketingShell title="Settings">{(org) => <BrandSettingsPanel org={org} />}</EmailMarketingShell>;
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <Inner />
    </Suspense>
  );
}
