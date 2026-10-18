"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useSupportStore } from "@/stores/support.store";
import HelpSubNav from "@/components/help/HelpSubNav";
import type { TicketCategory, TicketStatus } from "@/types/support.types";

const statusStyles: Record<string, string> = {
  pending:     "text-warning",
  open:        "text-warning",
  in_progress: "text-primary",
  resolved:    "text-success",
  closed:      "text-muted-foreground",
  failed:      "text-destructive",
};

const categoryOptions: { label: string; value: TicketCategory | "all" }[] = [
  { label: "All Category", value: "all" },
  { label: "Account",      value: "account" },
  { label: "Dispute",      value: "dispute" },
  { label: "Insurance",    value: "insurance" },
  { label: "Report",       value: "report" },
];

const formatDate = (iso: string) => {
  const d = new Date(iso);
  return (
    d.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" }) +
    "  " +
    d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
  );
};

const formatIssueType = (issueType: string) =>
  issueType?.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) ?? "—";

export default function TicketsPage() {
  const router = useRouter();
  const { tickets, fetchTickets, isLoadingTickets, ticketPagination } = useSupportStore();

  const [selectedCategory, setSelectedCategory] = useState<TicketCategory | "all">("all");
  const [showDropdown, setShowDropdown] = useState(false);

  useEffect(() => {
    fetchTickets(selectedCategory === "all" ? {} : { category: selectedCategory });
  }, [fetchTickets, selectedCategory]);

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
          <div className="flex items-center justify-between p-4">
            <h2 className="text-[14px] font-bold text-foreground">Tickets</h2>

            {/* Category filter */}
            <div className="relative">
              <button
                onClick={() => setShowDropdown((v) => !v)}
                className="flex items-center gap-2 border border-border rounded-md px-3 py-1.5 hover:bg-muted transition-colors"
              >
                <span className="text-[12px] font-medium text-muted-foreground capitalize">
                  {categoryOptions.find((c) => c.value === selectedCategory)?.label}
                </span>
                <span className="text-[10px] text-muted-foreground">▼</span>
              </button>

              {showDropdown && (
                <div className="absolute right-0 top-9 z-50 bg-card border border-border rounded-md shadow-lg min-w-[140px]">
                  {categoryOptions.map((cat) => (
                    <button
                      key={cat.value}
                      onClick={() => { setSelectedCategory(cat.value); setShowDropdown(false); }}
                      className="w-full text-left px-3 py-2 text-[12px] text-foreground capitalize hover:bg-muted transition-colors"
                    >
                      {cat.label}
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
                  {["Ticket ID", "Product Suite", "Ticket Title", "Ticket Type", "Agent", "Date", "Client Name", "Status"].map((h) => (
                    <th key={h} className="text-[11px] font-semibold text-muted-foreground text-left py-3 px-4 whitespace-nowrap uppercase tracking-wider">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {isLoadingTickets ? (
                  Array.from({ length: 5 }).map((_, i) => (
                    <tr key={i}>
                      {Array.from({ length: 8 }).map((_, j) => (
                        <td key={j} className="py-4 px-4">
                          <div className="h-3 bg-muted animate-pulse rounded w-24" />
                        </td>
                      ))}
                    </tr>
                  ))
                ) : tickets.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="text-center text-[12px] text-muted-foreground py-8">
                      No tickets found
                    </td>
                  </tr>
                ) : (
                  tickets.map((ticket, i) => (
                    <tr
                      key={`${ticket.ticketCategory}-${ticket.id}-${i}`}
                      onClick={() => router.push(`/dashboard/help/tickets/${ticket.id}`)}
                      className="hover:bg-muted transition-colors cursor-pointer"
                    >
                      <td className="text-[11px] text-muted-foreground py-4 px-4 whitespace-nowrap">
                        #{ticket.id}
                      </td>
                      <td className="text-[11px] text-foreground py-4 px-4 whitespace-nowrap">
                        Healthnet
                      </td>
                      <td className="text-[11px] font-medium text-foreground py-4 px-4 whitespace-nowrap max-w-[160px] truncate">
                        {formatIssueType(ticket.issueType as string ?? "")}
                      </td>
                      <td className="text-[11px] text-foreground py-4 px-4 whitespace-nowrap capitalize">
                        {ticket.ticketCategory}
                      </td>
                      <td className="text-[11px] text-foreground py-4 px-4 whitespace-nowrap">
                        —
                      </td>
                      <td className="text-[11px] text-muted-foreground py-4 px-4 whitespace-nowrap">
                        {ticket.createdAt ? formatDate(ticket.createdAt) : "—"}
                      </td>
                      <td className="text-[11px] text-foreground py-4 px-4 whitespace-nowrap">
                        {ticket.users?.fullName ?? "—"}
                      </td>
                      <td className={`text-[11px] font-bold py-4 px-4 whitespace-nowrap capitalize ${statusStyles[ticket.status] ?? "text-foreground"}`}>
                        {ticket.status}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {ticketPagination && ticketPagination.totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-border">
              <span className="text-[11px] text-muted-foreground">
                Page {ticketPagination.currentPage} of {ticketPagination.totalPages} · {ticketPagination.totalItems} tickets
              </span>
              <div className="flex gap-2">
                <button
                  disabled={ticketPagination.currentPage === 1}
                  onClick={() => fetchTickets({
                    category: selectedCategory === "all" ? undefined : selectedCategory,
                    page: ticketPagination.currentPage - 1,
                  })}
                  className="text-[11px] px-3 py-1 border border-border rounded-md hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Prev
                </button>
                <button
                  disabled={ticketPagination.currentPage === ticketPagination.totalPages}
                  onClick={() => fetchTickets({
                    category: selectedCategory === "all" ? undefined : selectedCategory,
                    page: ticketPagination.currentPage + 1,
                  })}
                  className="text-[11px] px-3 py-1 border border-border rounded-md hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}