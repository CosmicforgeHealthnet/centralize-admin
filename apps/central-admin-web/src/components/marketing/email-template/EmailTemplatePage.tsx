// src/components/marketing/email-template/EmailTemplatePage.tsx
"use client";
import { useDebouncedSearch } from "@/components/marketing/shared/useDebouncedSearch";

import MailState from "@/components/mail/MailState";
import { PanelsTopLeft as EmptyIcon } from "lucide-react";
import TableScrollArea from "@/components/marketing/shared/TableScrollArea";

import SearchField from "@/components/marketing/shared/SearchField";

import { useState, useEffect } from "react";
import { Edit, Trash2, PlusCircle } from "lucide-react";
import EventView from "./EventView";
import { useMarketingStore } from "@/stores/marketing.store";
import { Skeleton } from "@/components/ui/skeleton";
import type { EmailTemplateListItem } from "@/types/marketing.types";
import CreateEmailTemplateModal from "./CreateEmailTemplateModal";

export default function EmailTemplatePage() {
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const {
    emailTemplates,
    emailTemplatePagination,
    emailTemplateFilters,
    isLoadingEmailTemplates,
    error,
    fetchEmailTemplates,
    setEmailTemplateFilters,
    deleteEmailTemplate,
    clearError,
  } = useMarketingStore();

  const [showCreateModal, setShowCreateModal] = useState(false);

  useEffect(() => {
    fetchEmailTemplates();
  }, [emailTemplateFilters, fetchEmailTemplates]);

  useEffect(() => {
    if (error) {
      const timer = setTimeout(() => clearError(), 5000);
      return () => clearTimeout(timer);
    }
  }, [error, clearError]);

  const handleSearch = () => {
    setEmailTemplateFilters({ search, page: 1 });
  };
  useDebouncedSearch(search, handleSearch);

  const filtered = emailTemplates.filter((r) =>
    r.event.toLowerCase().includes(search.toLowerCase())
  );

  if (selectedId) {
    return <EventView templateId={selectedId} onBack={() => setSelectedId(null)} />;
  }

  if (isLoadingEmailTemplates && emailTemplates.length === 0) {
    return (
      <div className="flex flex-col gap-5">
        <div>
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-32 mt-1" />
        </div>
        <div className="flex flex-col sm:flex-row sm:items-center gap-2.5 flex-wrap">
          <Skeleton className="h-10 w-48 rounded-lg flex-1" />
          <Skeleton className="h-10 w-20 rounded-lg" />
          <Skeleton className="h-10 w-32 rounded-lg ml-auto" />
        </div>
        <div className="bg-card rounded-xl border border-border overflow-hidden">
          <div className="p-8 flex items-center justify-center">
            <Skeleton className="h-[400px] w-full" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
          {error}
        </div>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><p className="text-sm leading-6 text-muted-foreground">Manage event templates and notification channels.</p><button
  onClick={() => setShowCreateModal(true)}
  className="shrink-0 self-start px-4 py-2 bg-primary text-white text-[12px] font-poppins font-semibold rounded-lg hover:bg-primary/90 transition-colors h-[38px]  flex items-center gap-1.5"
>
  <PlusCircle className="w-3.5 h-3.5" />
  Create Template
</button></div>

      <div className="marketing-toolbar flex flex-col sm:flex-row sm:items-center gap-2.5 flex-wrap">
        <SearchField value={search}
            onChange={(e) => setSearch(e.target.value)}

            placeholder="Search email templates" />


      </div>

      <div className="bg-card rounded-xl border border-border overflow-hidden">
        {filtered.length === 0 && !isLoadingEmailTemplates ? <MailState icon={EmptyIcon} title="No templates found" description="Try another search or create a template." /> : (<TableScrollArea className="overflow-x-auto">
          <table className="w-full min-w-[820px]">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                {["Event Code", "Event", "Notification", "Valid to date", "Action"].map((h) => (
                  <th scope="col" key={h} className="text-left py-2.5 px-4 text-[12px] font-poppins font-semibold text-muted-foreground whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={5} className="text-center py-12 text-muted-foreground font-poppins text-[12px]">
                    {isLoadingEmailTemplates ? "Loading..." : "No templates found"}
                  </td>
                </tr>
              ) : (
                filtered.map((row) => (
                  <tr
                    key={row.id}
                    className="border-b border-border/50 hover:bg-muted/20 transition-colors cursor-pointer"
                    onClick={() => setSelectedId(row.id)}
                  >
                    <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">
                      {row.eventCode}
                    </td>
                    <td className="py-3 px-4 font-poppins text-[12px] font-semibold text-foreground underline whitespace-nowrap">
                      {row.event}
                    </td>
                    <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">
                      Customer - {row.customerChannels?.join(", ") || "—"} <br />
                      <span className="text-muted-foreground">
                        Recipient - {row.recipientChannels?.join(", ") || "—"}
                      </span>
                    </td>
                    <td className="py-3 px-4 font-poppins text-[12px] text-muted-foreground whitespace-nowrap">
                      {row.validToDate || "—"}
                    </td>
                    <td className="py-3 px-4" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center gap-2.5">
                        <button
                          onClick={() => setSelectedId(row.id)}
                          className="text-primary hover:text-primary/70 transition-colors"
                        >
                          <Edit className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => deleteEmailTemplate(row.id)}
                          className="text-red-500 hover:text-red-400 transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </TableScrollArea>)}
      </div>

      {emailTemplatePagination && emailTemplatePagination.totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 mt-2">
          <button
            onClick={() => setEmailTemplateFilters({ page: Math.max(1, emailTemplateFilters.page - 1) })}
            disabled={emailTemplateFilters.page <= 1}
            className="px-3 py-1 border border-border rounded-lg text-[12px] font-poppins disabled:opacity-50 disabled:cursor-not-allowed hover:bg-muted/50 transition-colors"
          >
            Previous
          </button>
          <span className="font-poppins text-[12px] text-muted-foreground">
            Page {emailTemplateFilters.page} of {emailTemplatePagination.totalPages}
          </span>
          <button
            onClick={() => setEmailTemplateFilters({ page: Math.min(emailTemplatePagination.totalPages, emailTemplateFilters.page + 1) })}
            disabled={emailTemplateFilters.page >= emailTemplatePagination.totalPages}
            className="px-3 py-1 border border-border rounded-lg text-[12px] font-poppins disabled:opacity-50 disabled:cursor-not-allowed hover:bg-muted/50 transition-colors"
          >
            Next
          </button>
        </div>
      )}
      {showCreateModal && <CreateEmailTemplateModal onClose={() => setShowCreateModal(false)} />}
    </div>
  );
}