"use client";

import { useState } from "react";
import Image from "next/image";
import { ChevronLeft, ChevronRight } from "lucide-react";

interface SalesRow {
  id: number;
  orderId: string;
  date: string;
  status: "Paid" | "Pending" | "Refunded";
  price: string;
  customerName: string;
  customerEmail: string;
  customerAvatar?: string;
}

const MOCK_SALES: SalesRow[] = Array.from({ length: 40 }, (_, i) => ({
  id: i + 1,
  orderId: `#${874333 + i}`,
  date: "31/01/2025",
  status: (["Paid", "Paid", "Pending", "Refunded", "Paid"] as const)[i % 5],
  price: "₦ 3,500.00",
  customerName: ["Dr Josh Olawale", "Dr Sarah Mensah", "Dr Amara Osei", "Dr Tunde Bello", "Dr Ngozi Eze"][i % 5],
  customerEmail: ["rexyinc@gmail.com", "sarah.m@gmail.com", "amara.o@gmail.com", "tunde.b@gmail.com", "ngozi.e@gmail.com"][i % 5],
}));

const STATUS_STYLE: Record<SalesRow["status"], string> = {
  Paid: "text-emerald-600",
  Pending: "text-amber-600",
  Refunded: "text-red-500",
};

const PAGE_SIZE = 10;

function Avatar({ name }: { name: string }) {
  return (
    <div className="w-7 h-7 rounded-full bg-[#E8E9FF] overflow-hidden shrink-0 flex items-center justify-center">
      <span className="text-[10px] font-poppins font-bold text-[#272EA7]">
        {name.replace(/^Dr\s+/, "").charAt(0)}
      </span>
    </div>
  );
}

export default function FinanceSalesHistoryTable() {
  const [page, setPage] = useState(1);

  const totalPages = Math.ceil(MOCK_SALES.length / PAGE_SIZE);
  const paginated = MOCK_SALES.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const pageNums: (number | "…")[] = (() => {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
    if (page <= 4) return [1, 2, 3, 4, 5, "…", totalPages];
    if (page >= totalPages - 3) return [1, "…", totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
    return [1, "…", page - 1, page, page + 1, "…", totalPages];
  })();

  return (
    <div>
      <p className="text-[14px] font-poppins font-semibold text-gray-800 mb-3">Sales History</p>

      {/* Desktop table */}
      <div className="hidden md:block overflow-x-auto rounded-[12px] border border-gray-100">
        <table className="min-w-[700px] w-full">
          <thead>
            <tr className="bg-gray-50/60 border-b border-gray-100">
              {["No", "Order ID", "Date", "Status", "Price", "Customer"].map((h) => (
                <th key={h} className="px-4 py-3 text-left text-[11px] font-poppins font-semibold text-gray-500 tracking-wide whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {paginated.map((row, idx) => (
              <tr key={row.id} className={`border-b border-gray-50 hover:bg-[#F8F9FE] transition-colors ${idx % 2 === 0 ? "" : "bg-gray-50/30"}`}>
                <td className="px-4 py-3 text-[12px] font-poppins text-gray-400">{row.id}</td>
                <td className="px-4 py-3 text-[12px] font-poppins font-medium text-gray-700">{row.orderId}</td>
                <td className="px-4 py-3 text-[12px] font-poppins text-gray-500 whitespace-nowrap">{row.date}</td>
                <td className="px-4 py-3">
                  <span className={`text-[12px] font-poppins font-semibold ${STATUS_STYLE[row.status]}`}>
                    {row.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-[12px] font-poppins font-semibold text-gray-800 whitespace-nowrap">{row.price}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Avatar name={row.customerName} />
                    <div>
                      <p className="text-[12px] font-poppins font-medium text-gray-800 whitespace-nowrap">{row.customerName}</p>
                      <p className="text-[11px] font-poppins text-gray-400 truncate max-w-[160px]">{row.customerEmail}</p>
                    </div>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden flex flex-col gap-3">
        {paginated.map((row) => (
          <div key={row.id} className="bg-white rounded-[12px] border border-gray-100 p-3.5 shadow-[0_1px_6px_rgba(0,0,0,0.04)]">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <Avatar name={row.customerName} />
                <div>
                  <p className="text-[13px] font-poppins font-semibold text-gray-800">{row.customerName}</p>
                  <p className="text-[11px] font-poppins text-gray-400">{row.customerEmail}</p>
                </div>
              </div>
              <span className={`text-[12px] font-poppins font-semibold ${STATUS_STYLE[row.status]}`}>
                {row.status}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-1.5 mt-2">
              <div>
                <p className="text-[10px] font-poppins text-gray-400">Order ID</p>
                <p className="text-[12px] font-poppins font-medium text-gray-700">{row.orderId}</p>
              </div>
              <div>
                <p className="text-[10px] font-poppins text-gray-400">Price</p>
                <p className="text-[12px] font-poppins font-semibold text-gray-800">{row.price}</p>
              </div>
              <div>
                <p className="text-[10px] font-poppins text-gray-400">Date</p>
                <p className="text-[12px] font-poppins text-gray-600">{row.date}</p>
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
            className="w-7 h-7 flex items-center justify-center rounded-[6px] border border-gray-200 hover:border-[#272EA7] hover:text-[#272EA7] disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-gray-500"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
          </button>
          {pageNums.map((n, idx) =>
            n === "…" ? (
              <span key={`e-${idx}`} className="w-7 h-7 flex items-center justify-center text-[12px] font-poppins text-gray-400">…</span>
            ) : (
              <button
                key={n}
                onClick={() => setPage(n as number)}
                className={`w-7 h-7 flex items-center justify-center rounded-[6px] text-[12px] font-poppins font-medium transition-colors ${
                  page === n ? "bg-[#272EA7] text-white" : "border border-gray-200 text-gray-500 hover:border-[#272EA7] hover:text-[#272EA7]"
                }`}
              >
                {n}
              </button>
            )
          )}
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            className="w-7 h-7 flex items-center justify-center rounded-[6px] border border-gray-200 hover:border-[#272EA7] hover:text-[#272EA7] disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-gray-500"
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}