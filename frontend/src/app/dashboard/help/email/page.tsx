"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight } from "lucide-react";
import HelpSubNav from "@/components/help/HelpSubNav";

const channels = [
  { name: "Cosmicforge Support", email: "support@cosmicforge.healthnet.help.com" },
];

export default function EmailSupportPage() {
  const router = useRouter();
  const [priorityToggle, setPriorityToggle] = useState(true);

  return (
    <div className="flex gap-4">
      {/* Sub Nav — desktop */}
      <div className="hidden min-[1014px]:block w-[160px] shrink-0">
        <HelpSubNav />
      </div>

      <div className="flex-1 min-w-0 flex flex-col gap-4">
        {/* Mobile subnav */}
        <div className="min-[1014px]:hidden">
          <HelpSubNav />
        </div>

        {/* Main card */}
        <div className="bg-card rounded-lg border border-border w-full min-w-0 overflow-hidden">
          <div className="p-6 flex flex-col gap-8">

            {/* Section 1 — Email Support Settings */}
            <div>
              <h2 className="text-body-text font-bold text-primary mb-4">
                Email Support Settings
              </h2>
              <div className="border-t border-border" />

              <div className="flex items-start justify-between gap-4 pt-4">
                <div>
                  <p className="text-priority text-foreground">
                    Priority emails to customers with agent&apos;s nickname
                  </p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    Agent nicknames will be used in all email conversations with customers.
                  </p>
                </div>

                {/* Toggle */}
                <button
                  onClick={() => setPriorityToggle(!priorityToggle)}
                  className={`relative shrink-0 w-11 h-6 rounded-full transition-colors duration-200 ${
                    priorityToggle ? "bg-primary" : "bg-input"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 w-5 h-5 bg-primary-foreground rounded-full shadow transition-all duration-200 ${
                      priorityToggle ? "left-[22px]" : "left-0.5"
                    }`}
                  />
                </button>
              </div>
            </div>

            {/* Section 2 — Email Support Channels */}
            <div>
              <h2 className="text-body-text font-bold text-primary mb-4">
                Email Support Channels
              </h2>
              <div className="border-t border-border mb-4" />

              <p className="text-priority text-foreground mb-1">
                You can use the Support Channel medium to handle Email Issues.
              </p>
              <p className="text-[11px] text-muted-foreground mb-4">
                An email support channel let&apos;s you customize your email replies to your customers.
              </p>

              {/* Channel rows */}
              <div className="flex flex-col gap-2 mb-4">
                {channels.map((ch, i) => (
                  <button
                    key={i}
                    onClick={() => router.push("/dashboard/help/email/channel")}
                    className="flex items-center justify-between gap-4 bg-secondary border border-border rounded-md px-4 py-3 hover:bg-accent transition-colors w-full text-left"
                  >
                    <span className="text-[12px] font-semibold text-foreground">{ch.name}</span>
                    <span className="text-[12px] text-muted-foreground flex-1 text-center">{ch.email}</span>
                    <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
                  </button>
                ))}
              </div>

              {/* Add Channel button */}
              <button className="bg-primary hover:bg-primary/90 transition-colors text-primary-foreground text-[13px] font-semibold px-6 py-2.5 rounded-md">
                Add Channel
              </button>
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}