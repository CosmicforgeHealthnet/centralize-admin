"use client";

import { Suspense } from "react";

import EmailMarketingShell from "@/components/marketing/email-marketing/EmailMarketingShell";
import EmailMarketingOverview from "@/components/marketing/email-marketing/EmailMarketingOverview";

function Inner() {

  return <EmailMarketingShell title="Overview">{(org) => <EmailMarketingOverview org={org} />}</EmailMarketingShell>;
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <Inner />
    </Suspense>
  );
}
