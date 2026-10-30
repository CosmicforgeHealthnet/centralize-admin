"use client";

import { useEffect, useState } from "react";
import { useSupportStore } from "@/stores/support.store";

const statusStyles: Record<string, string> = {
  pending:     "text-warning",
  failed:      "text-destructive",
  resolved:    "text-success",
  open:        "text-warning",
  in_progress: "text-primary",
  closed:      "text-muted-foreground",
};

const categoryOptions = ["All Category", "account", "dispute", "insurance", "report"];

const formatDate = (iso: string) => {
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", {
    day: "2-digit", month: "2-digit", year: "numeric",
  }) + " " + d.toLocaleTimeString("en-GB", {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
};

const formatIssueType = (issueType: string) =>
  issueType?.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) ?? "—";

export default function RecentTickets() {
  const { tickets, fetchTickets, isLoadingTickets } = useSupportStore();
  const [selectedCategory, setSelectedCategory] = useState("All Category");
  const [showDropdown, setShowDropdown] = useState(false);

  useEffect(() => {
    fetchTickets();
  }, [fetchTickets]);

  const filtered = selectedCategory === "All Category"
    ? tickets
    : tickets.filter((t) => t.ticketCategory === selectedCategory);

  return (
    <div className="bg-card rounded-lg border border-border flex flex-col w-full min-w-0 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between p-4">
        <h2 className="text-[14px] font-bold text-foreground">Recent Tickets</h2>

        {/* Category filter dropdown */}
        <div className="relative">
          <button
            onClick={() => setShowDropdown((v) => !v)}
            className="flex items-center gap-2 border border-border rounded-md px-3 py-1.5 hover:bg-muted transition-colors"
          >
            <span className="text-[12px] font-medium text-muted-foreground capitalize">
              {selectedCategory}
            </span>
            <span className="text-[10px] text-muted-foreground">▼</span>
          </button>

          {showDropdown && (
            <div className="absolute right-0 top-9 z-50 bg-card border border-border rounded-md shadow-lg min-w-[140px]">
              {categoryOptions.map((cat) => (
                <button
                  key={cat}
                  onClick={() => { setSelectedCategory(cat); setShowDropdown(false); }}
                  className="w-full text-left px-3 py-2 text-[12px] text-foreground capitalize hover:bg-muted transition-colors"
                >
                  {cat}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-secondary border-y border-border">
              {["Ticket ID", "Ticket Title", "Ticket Type", "Date", "Client Name", "Status"].map((h) => (
                <th
                  key={h}
                  className="text-[11px] font-bold text-foreground text-left py-3 px-4 whitespace-nowrap uppercase tracking-wider"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {isLoadingTickets ? (
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}>
                  {Array.from({ length: 6 }).map((_, j) => (
                    <td key={j} className="py-4 px-4">
                      <div className="h-3 bg-muted animate-pulse rounded w-24" />
                    </td>
                  ))}
                </tr>
              ))
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-center text-[12px] text-muted-foreground py-8">
                  No tickets found
                </td>
              </tr>
            ) : (
              filtered.map((ticket, i) => (
                <tr key={`${ticket.ticketCategory}-${ticket?.id}-${i}`} className="hover:bg-muted transition-colors">
                  <td className="text-[11px] text-muted-foreground py-4 px-4 whitespace-nowrap">
                    #{ticket?.id}
                  </td>
                  <td className="text-[11px] font-medium text-foreground py-4 px-4 whitespace-nowrap max-w-[160px] truncate">
                    {formatIssueType(ticket?.issueType as string ?? "")}
                  </td>
                  <td className="text-[11px] text-foreground py-4 px-4 whitespace-nowrap capitalize">
                    {ticket.ticketCategory}
                  </td>
                  <td className="text-[11px] text-muted-foreground py-4 px-4 whitespace-nowrap">
                    {ticket.createdAt ? formatDate(ticket?.createdAt) : "—"}
                  </td>
                  <td className="text-[11px] text-foreground py-4 px-4 whitespace-nowrap">
                    {ticket.users?.fullName ?? "—"}
                  </td>
                  <td className={`text-[11px] font-bold py-4 px-4 whitespace-nowrap capitalize ${statusStyles[ticket.status] ?? "text-foreground"}`}>
                    {ticket?.status}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}