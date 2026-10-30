"use client";

import Link from "next/link";
import { ChevronRight, Inbox } from "lucide-react";
import HelpSubNav from "@/components/help/HelpSubNav";
import PermissionBoundary from "@/components/mail/PermissionBoundary";
import { useQuery } from "@tanstack/react-query";
import { mailKeys } from "@/components/mail/hooks";
import { fetchSupportMailboxes } from "@/lib/mail.service";
import type { SupportMailboxSummary } from "@/types/mail.types";

export default function EmailSupportPage() {
  const q = useQuery({ queryKey: mailKeys.support, queryFn: fetchSupportMailboxes, gcTime: 5 * 60 * 1000, retry: false });
  // The API returns queue counts (open/overdue), not an unread count.
  const mailboxes: SupportMailboxSummary[] = q.data ?? [];

  return (
    <div className="flex gap-4">
      <div className="hidden min-[1014px]:block w-[160px] shrink-0">
        <HelpSubNav />
      </div>

      <div className="flex-1 min-w-0 flex flex-col gap-4">
        <div className="min-[1014px]:hidden">
          <HelpSubNav />
        </div>

        <div className="bg-card rounded-lg border border-border w-full min-w-0 overflow-hidden">
          <div className="p-6 flex flex-col gap-6">
            <div>
              <h2 className="text-body-text font-bold text-primary mb-4">Email Support Channels</h2>
              <div className="border-t border-border mb-4" />
              <p className="text-priority text-foreground mb-1">
                Shared support mailboxes you are a member of.
              </p>
              <p className="text-[11px] text-muted-foreground mb-4">
                Each channel is a CosmicForge Mail shared mailbox. Replies are sent from the mailbox&apos;s approved
                support address, and every agent action is recorded.
              </p>

              <PermissionBoundary
                isLoading={q.isLoading}
                error={q.error}
                retry={() => q.refetch()}
                loadingLabel="Loading support mailboxes"
                forbiddenMessage="You do not have access to shared support mailboxes."
              >
                {mailboxes.length === 0 ? (
                  <div role="status" className="flex flex-col items-center gap-2 rounded-md border border-dashed border-border p-6 text-center">
                    <Inbox className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
                    <p className="text-[12px] font-semibold text-foreground">No shared support mailbox access</p>
                    <p className="max-w-md text-[11px] text-muted-foreground">
                      You are not a member of any Support shared mailbox. A mail administrator or the mailbox manager must
                      add you before you can work the support email queue.
                    </p>
                  </div>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {mailboxes.map((mb) => (
                      <li key={mb.id}>
                        <Link
                          href={`/dashboard/help/email/channel?mailboxId=${mb.id}`}
                          className="flex items-center justify-between gap-4 bg-secondary border border-border rounded-md px-4 py-3 hover:bg-accent transition-colors w-full text-left"
                        >
                          <span className="text-[12px] font-semibold text-foreground">{mb.name}</span>
                          <span className="text-[12px] text-muted-foreground flex-1 text-center truncate">
                            {mb.primaryAddress ?? "No primary address"}
                          </span>
                          <span className="flex items-center gap-1 shrink-0">
                            <span className="rounded-full bg-primary px-2 text-[10px] font-semibold text-primary-foreground">
                              {mb.openCount} open
                            </span>
                            {mb.overdueCount > 0 && (
                              <span className="rounded-full bg-red-600 px-2 text-[10px] font-semibold text-white">
                                {mb.overdueCount} overdue
                              </span>
                            )}
                          </span>
                          <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" aria-hidden="true" />
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </PermissionBoundary>
              <p className="mt-4 text-[11px] text-muted-foreground">
                New support channels are provisioned by a mail administrator.{" "}
                <Link href="/dashboard/mail/settings" className="text-primary underline">Request a channel</Link>
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
