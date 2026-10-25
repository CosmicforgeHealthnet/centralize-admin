"use client";

import { Suspense } from "react";

import EmailMarketingShell from "@/components/marketing/email-marketing/EmailMarketingShell";
import AutomationStudio from "@/components/marketing/email-marketing/AutomationStudio";

function Inner() {

  return <EmailMarketingShell title="Automation">{(org) => <AutomationStudio org={org} />}</EmailMarketingShell>;
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <Inner />
    </Suspense>
  );
}
