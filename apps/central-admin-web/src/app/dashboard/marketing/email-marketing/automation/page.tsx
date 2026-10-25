"use client";

import { Suspense } from "react";

import EmailMarketingShell from "@/components/marketing/email-marketing/EmailMarketingShell";
import AutomationNotice from "@/components/marketing/email-marketing/AutomationNotice";

function Inner() {

  return <EmailMarketingShell title="Automation">{() => <AutomationNotice />}</EmailMarketingShell>;
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <Inner />
    </Suspense>
  );
}
