"use client";

import { Suspense } from "react";

import EmailMarketingShell from "@/components/marketing/email-marketing/EmailMarketingShell";
import TemplateList from "@/components/marketing/email-marketing/TemplateList";

function Inner() {

  return <EmailMarketingShell title="Templates">{(org) => <TemplateList org={org} />}</EmailMarketingShell>;
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <Inner />
    </Suspense>
  );
}
