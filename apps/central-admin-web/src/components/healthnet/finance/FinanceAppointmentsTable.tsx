"use client";

import { useState } from "react";
import Image from "next/image";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";

interface AppointmentRow {
  id: number;
  payerName: string;
  payerAvatar?: string;
  paymentMode: "Transfer" | "Card" | "Cash";
  bank: string;
  amount: string;
  description: string;
  date: string;
  status: "Successful" | "Pending" | "Failed";
}

const MOCK_APPOINTMENTS: AppointmentRow[] = Array.from({ length: 40 }, (_, i) => ({
  id: i + 1,
  payerName: ["Dr Josh Olawale", "Dr Sarah Mensah", "Dr Amara Osei", "Dr Tunde Bello", "Dr Ngozi Eze"][i % 5],
  paymentMode: (["Transfer", "Card", "Transfer", "Cash", "Card"] as const)[i % 5],
  bank: i % 3 === 1 ? "**** **** **** 2345" : "0421361071\nGuarantee Trust Bank",
  amount: "₦ 23,000.00",
  description: ["Doctor's Appointment", "Lab Test", "Pharmacy Purchase", "Consultation"][i % 4],
  date: "31/01/2025",
  status: (["Successful", "Successful", "Pending", "Failed", "Successful"] as const)[i % 5],
}));

const STATUS_STYLE: Record<AppointmentRow["status"], string> = {
  Successful: "text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-500/20",
  Pending: "text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-500/20",
  Failed: "text-red-500 dark:text-red-400 bg-red-50 dark:bg-red-500/20",
};

const PAGE_SIZE = 10;
const FILTERS = ["Today", "This Week", "This Month", "This Year"];

function Avatar({ name, src }: { name: string; src?: string }) {
  return (
    <div className="w-7 h-7 rounded-full bg-secondary overflow-hidden shrink-0 flex items-center justify-center">
      {src ? (
        <Image src={src} alt={name} width={28} height={28} className="w-full h-full object-cover" />
      ) : (
        <span className="text-[10px] font-poppins font-bold text-primary">
          {name.replace(/^Dr\s+/, "").charAt(0)}
        </span>
      )}
    </div>
  );
}

export default function FinanceAppointmentsTable() {
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState("Today");
  const [filterOpen, setFilterOpen] = useState(false);

  const totalPages = Math.ceil(MOCK_APPOINTMENTS.length / PAGE_SIZE);
  const paginated = MOCK_APPOINTMENTS.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const pageNums: (number | "…")[] = (() => {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
    if (page <= 4) return [1, 2, 3, 4, 5, "…", totalPages];
    if (page >= totalPages - 3) return [1, "…", totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
    return [1, "…", page - 1, page, page + 1, "…", totalPages];
  })();

  return (
    <div>
      {/* Table header */}
      <div className="flex items-center justify-between mb-3">
        <p className="text-[14px] font-poppins font-semibold text-foreground">Appointments</p>
        <div className="relative">
          <button
            onClick={() => setFilterOpen((o) => !o)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-card border border-border rounded-[8px] text-[12px] font-poppins text-foreground shadow-[0_1px_4px_rgba(0,0,0,0.06)] dark:shadow-[0_1px_4px_rgba(0,0,0,0.2)] hover:border-primary/40 transition-colors"
          >
            {filter}
            <ChevronDown className={`w-3 h-3 text-muted-foreground transition-transform ${filterOpen ? "rotate-180" : ""}`} />
          </button>
          {filterOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setFilterOpen(false)} />
              <div className="absolute right-0 top-full mt-1 z-20 bg-card border border-border rounded-[8px] shadow-[0_4px_16px_rgba(0,0,0,0.10)] dark:shadow-[0_4px_16px_rgba(0,0,0,0.3)] overflow-hidden min-w-[120px]">
                {FILTERS.map((f) => (
                  <button
                    key={f}
                    onClick={() => { setFilter(f); setFilterOpen(false); setPage(1); }}
                    className={`w-full text-left px-3.5 py-2 text-[12px] font-poppins transition-colors ${
                      filter === f 
                        ? "bg-primary/8 text-primary font-semibold" 
                        : "text-muted-foreground hover:bg-muted/50"
                    }`}
                  >
                    {f}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Desktop table */}
      <div className="hidden md:block overflow-x-auto rounded-[12px] border border-border">
        <table className="min-w-[800px] w-full">
          <thead>
            <tr className="bg-muted/30 border-b border-border">
              {["No", "Payer Name", "Payment Mode", "Bank", "Amount", "Description", "Date", "Status"].map((h) => (
                <th key={h} className="px-4 py-3 text-left text-[11px] font-poppins font-semibold text-muted-foreground tracking-wide whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {paginated.map((row, idx) => (
              <tr key={row.id} className={`border-b border-border hover:bg-muted/50 transition-colors ${idx % 2 === 0 ? "" : "bg-muted/20"}`}>
                <td className="px-4 py-3 text-[12px] font-poppins text-muted-foreground">{row.id}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Avatar name={row.payerName} />
                    <span className="text-[12px] font-poppins font-medium text-foreground whitespace-nowrap">{row.payerName}</span>
                  </div>
                </td>
                <td className="px-4 py-3 text-[12px] font-poppins text-muted-foreground">{row.paymentMode}</td>
                <td className="px-4 py-3 text-[11px] font-poppins text-muted-foreground whitespace-pre-line leading-tight">{row.bank}</td>
                <td className="px-4 py-3 text-[12px] font-poppins font-semibold text-foreground whitespace-nowrap">{row.amount}</td>
                <td className="px-4 py-3 text-[12px] font-poppins text-muted-foreground">{row.description}</td>
                <td className="px-4 py-3 text-[12px] font-poppins text-muted-foreground whitespace-nowrap">{row.date}</td>
                <td className="px-4 py-3">
                  <span className={`px-2.5 py-1 rounded-[6px] text-[11px] font-poppins font-semibold ${STATUS_STYLE[row.status]}`}>
                    {row.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden flex flex-col gap-3">
        {paginated.map((row) => (
          <div key={row.id} className="bg-card rounded-[12px] border border-border p-3.5 shadow-[0_1px_6px_rgba(0,0,0,0.04)] dark:shadow-[0_1px_6px_rgba(0,0,0,0.2)]">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <Avatar name={row.payerName} />
                <span className="text-[13px] font-poppins font-semibold text-foreground">{row.payerName}</span>
              </div>
              <span className={`px-2.5 py-1 rounded-[6px] text-[11px] font-poppins font-semibold ${STATUS_STYLE[row.status]}`}>
                {row.status}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-1.5 mt-2">
              <div>
                <p className="text-[10px] font-poppins text-muted-foreground">Amount</p>
                <p className="text-[12px] font-poppins font-semibold text-foreground">{row.amount}</p>
              </div>
              <div>
                <p className="text-[10px] font-poppins text-muted-foreground">Payment Mode</p>
                <p className="text-[12px] font-poppins text-muted-foreground">{row.paymentMode}</p>
              </div>
              <div>
                <p className="text-[10px] font-poppins text-muted-foreground">Description</p>
                <p className="text-[12px] font-poppins text-muted-foreground">{row.description}</p>
              </div>
              <div>
                <p className="text-[10px] font-poppins text-muted-foreground">Date</p>
                <p className="text-[12px] font-poppins text-muted-foreground">{row.date}</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-1.5 pt-4">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
            className="w-7 h-7 flex items-center justify-center rounded-[6px] border border-border hover:border-primary hover:text-primary disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-muted-foreground"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
          </button>
          {pageNums.map((n, idx) =>
            n === "…" ? (
              <span key={`e-${idx}`} className="w-7 h-7 flex items-center justify-center text-[12px] font-poppins text-muted-foreground">…</span>
            ) : (
              <button
                key={n}
                onClick={() => setPage(n as number)}
                className={`w-7 h-7 flex items-center justify-center rounded-[6px] text-[12px] font-poppins font-medium transition-colors ${
                  page === n 
                    ? "bg-primary text-primary-foreground" 
                    : "border border-border text-muted-foreground hover:border-primary hover:text-primary"
                }`}
              >
                {n}
              </button>
            )
          )}
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            className="w-7 h-7 flex items-center justify-center rounded-[6px] border border-border hover:border-primary hover:text-primary disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-muted-foreground"
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}