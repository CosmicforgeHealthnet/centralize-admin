"use client";

import { Suspense } from "react";

import EmailMarketingShell from "@/components/marketing/email-marketing/EmailMarketingShell";
import AudiencesPanel from "@/components/marketing/email-marketing/AudiencesPanel";

function Inner() {

  return <EmailMarketingShell title="Audiences">{(org) => <AudiencesPanel org={org} />}</EmailMarketingShell>;
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <Inner />
    </Suspense>
  );
}
