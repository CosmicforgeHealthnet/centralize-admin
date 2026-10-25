"use client";

import { Suspense } from "react";
import { useParams } from "next/navigation";
import MailShell from "@/components/mail/MailShell";

export default function MailboxPage() {
  const { mailboxId } = useParams<{ mailboxId: string }>();
  return (
    <Suspense fallback={null}>
      <MailShell mailboxId={mailboxId} />
    </Suspense>
  );
}
