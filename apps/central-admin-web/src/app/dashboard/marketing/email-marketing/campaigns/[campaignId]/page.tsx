"use client";

import { Suspense } from "react";
import { useParams } from "next/navigation";
import EmailMarketingShell from "@/components/marketing/email-marketing/EmailMarketingShell";
import CampaignDetail from "@/components/marketing/email-marketing/CampaignDetail";

function Inner() {
  const { campaignId } = useParams<{ campaignId: string }>();
  return <EmailMarketingShell title="Campaign">{(org) => <CampaignDetail org={org} campaignId={campaignId} />}</EmailMarketingShell>;
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <Inner />
    </Suspense>
  );
}
