"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import IntegrationsAdmin from "@/components/mail/IntegrationsAdmin";

export default function MailIntegrationsPage() {
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <div className="flex items-center gap-2">
        <Link href="/dashboard/mail/settings" aria-label="Back to mail settings" className="rounded p-1.5 hover:bg-muted">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <h1 className="text-[15px] font-semibold">Product integrations</h1>
      </div>
      <IntegrationsAdmin />
    </div>
  );
}
