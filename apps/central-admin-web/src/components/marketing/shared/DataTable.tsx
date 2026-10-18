"use client";

import { Skeleton } from "@/components/ui/skeleton";
import EmptyState from "./EmptyState";

export interface DataTableColumn<T> {
  key: string;
  header: string;
  render: (row: T) => React.ReactNode;
  width?: string;
}

interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  isLoading?: boolean;
  emptyLabel?: string;
  pagination?: {
    currentPage: number;
    totalPages: number;
    onPageChange: (page: number) => void;
  };
}

export default function DataTable<T>({
  columns, rows, rowKey, isLoading, emptyLabel, pagination,
}: DataTableProps<T>) {
  if (isLoading) {
    return (
      <div className="flex flex-col gap-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-10 rounded-lg" />
        ))}
      </div>
    );
  }

  if (rows.length === 0) {
    return <EmptyState message={emptyLabel ?? "No data available"} />;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-muted/40 border-b border-border">
              {columns.map((col) => (
                <th
                  key={col.key}
                  style={{ width: col.width }}
                  className="text-left font-poppins text-[11px] font-semibold text-muted-foreground uppercase tracking-wide py-2.5 px-3 whitespace-nowrap"
                >
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={rowKey(row)} className="border-b border-border/60 last:border-b-0 hover:bg-muted/40 transition-colors">
                {columns.map((col) => (
                  <td key={col.key} className="py-2.5 px-3 font-poppins text-[12px] text-foreground align-middle">
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {pagination && pagination.totalPages > 1 && (
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <span className="font-poppins text-[11px] text-muted-foreground">
            Page {pagination.currentPage} of {pagination.totalPages}
          </span>
          <div className="flex items-center gap-2">
            <button
              disabled={pagination.currentPage <= 1}
              onClick={() => pagination.onPageChange(pagination.currentPage - 1)}
              className="font-poppins text-[11px] px-2.5 py-1 rounded-lg border border-border disabled:opacity-40 disabled:cursor-not-allowed text-foreground hover:border-muted-foreground/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              Previous
            </button>
            <button
              disabled={pagination.currentPage >= pagination.totalPages}
              onClick={() => pagination.onPageChange(pagination.currentPage + 1)}
              className="font-poppins text-[11px] px-2.5 py-1 rounded-lg border border-border disabled:opacity-40 disabled:cursor-not-allowed text-foreground hover:border-muted-foreground/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}