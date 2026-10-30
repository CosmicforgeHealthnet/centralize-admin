"use client";

import { Suspense } from "react";

import EmailMarketingShell from "@/components/marketing/email-marketing/EmailMarketingShell";
import ContactsPanel from "@/components/marketing/email-marketing/ContactsPanel";

function Inner() {

  return <EmailMarketingShell title="Contacts & consent">{(org) => <ContactsPanel org={org} />}</EmailMarketingShell>;
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <Inner />
    </Suspense>
  );
}
