"use client";

import { Workflow } from "lucide-react";
import { EmCard } from "./em-ui";

export default function AutomationNotice() {
  return (
    <EmCard title="Automation & dispatch" id="em-automation">
      <div role="status" className="flex items-start gap-3 text-[12px] text-muted-foreground">
        <Workflow className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
        <div className="flex flex-col gap-1">
          <p className="font-semibold text-foreground">Not available in this release</p>
          <p>
            Automated sequences, scheduled sends and live campaign dispatch are part of a separately authorized milestone (M7).
            Nothing in the Email Studio sends email to contacts today.
          </p>
          <p>
            Campaigns can be drafted, preflighted and approved now. Approval snapshots the exact content, sender and audience so a
            future dispatch can only send what was approved.
          </p>
        </div>
      </div>
    </EmCard>
  );
}
