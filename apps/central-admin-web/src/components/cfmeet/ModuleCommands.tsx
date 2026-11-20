"use client";

// A module's commands as CF Meet Admin exposes them: state, risk, whether a
// second approver is needed, and every blocker. Read only by design: actions
// are added with the approvals flow (propose, second person decides, run).

import { BlockerList, StateBadge } from "./CfMeetBlocked";
import { moduleCommands, type CfMeetCapabilities } from "./catalog";

export default function ModuleCommands({ caps, moduleId }: { caps: CfMeetCapabilities; moduleId: string }) {
  const commands = moduleCommands(caps, moduleId);
  if (commands.length === 0) return null;
  const available = commands.filter((c) => c.state === "AVAILABLE").length;
  return (
    <details className="group rounded-lg border border-border">
      <summary className="cursor-pointer list-none px-3 py-2 text-[12px] font-semibold text-foreground marker:hidden">
        Actions ({commands.length}) · {available} enabled
        <span className="ml-2 font-normal text-muted-foreground">Shown for reference; actions open with the approvals flow.</span>
      </summary>
      <ul aria-label="Module actions" className="flex flex-col divide-y divide-border border-t border-border">
        {commands.map((c) => (
          <li key={c.id} className="flex flex-col gap-1 px-3 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="break-all font-mono text-[11px] text-foreground">{c.id}</span>
              <StateBadge state={c.state} />
              <span className="rounded border border-border px-1.5 text-[10px] text-muted-foreground">{c.risk}</span>
              {c.requiresApproval && <span className="text-[10px] text-muted-foreground">Second approver required</span>}
            </div>
            <p className="text-[11px] text-muted-foreground">{c.description}</p>
            <BlockerList blockers={c.blockers} />
          </li>
        ))}
      </ul>
    </details>
  );
}
