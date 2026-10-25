"use client";

import { Suspense } from "react";

import EmailMarketingShell from "@/components/marketing/email-marketing/EmailMarketingShell";
import CampaignList from "@/components/marketing/email-marketing/CampaignList";

function Inner() {

  return <EmailMarketingShell title="Campaigns">{(org) => <CampaignList org={org} />}</EmailMarketingShell>;
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <Inner />
    </Suspense>
  );
}
