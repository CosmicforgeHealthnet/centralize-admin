"use client";

import { Suspense } from "react";
import { useParams } from "next/navigation";
import EmailMarketingShell from "@/components/marketing/email-marketing/EmailMarketingShell";
import TemplateEditor from "@/components/marketing/email-marketing/TemplateEditor";

function Inner() {
  const { templateId } = useParams<{ templateId: string }>();
  return <EmailMarketingShell title="Template editor">{(org) => <TemplateEditor org={org} templateId={templateId} />}</EmailMarketingShell>;
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <Inner />
    </Suspense>
  );
}
