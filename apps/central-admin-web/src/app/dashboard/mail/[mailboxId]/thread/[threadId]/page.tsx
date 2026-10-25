"use client";

import { Suspense } from "react";
import { useParams } from "next/navigation";
import MailShell from "@/components/mail/MailShell";

export default function MailThreadPage() {
  const { mailboxId, threadId } = useParams<{ mailboxId: string; threadId: string }>();
  return (
    <Suspense fallback={null}>
      <MailShell mailboxId={mailboxId} threadId={threadId} />
    </Suspense>
  );
}
