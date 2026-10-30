"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import PermissionBoundary from "@/components/mail/PermissionBoundary";
import { formatFullDate } from "@/components/mail/mail-utils";
import { classifyMailError } from "@/lib/mail.service";
import { createTemplate, fetchLegacyTemplates, fetchTemplates } from "@/lib/mail-marketing.service";
import type { MarketingOrganization } from "@/types/mail-marketing.types";
import { EmCard, EmField, EmMessage, emBtn, emInput } from "./em-ui";

export default function TemplateList({ org }: { org: MarketingOrganization }) {
  const router = useRouter();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["mail", "marketing", org.id, "templates"], queryFn: () => fetchTemplates(org.id), gcTime: 300000, retry: false });
  const legacy = useQuery({ queryKey: ["mail", "marketing", org.id, "legacy-templates"], queryFn: () => fetchLegacyTemplates(org.id), gcTime: 300000, retry: false });
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => createTemplate(org.id, { name: name.trim(), description: description.trim() || undefined }),
    onSuccess: (t) => {
      qc.invalidateQueries({ queryKey: ["mail", "marketing", org.id, "templates"] });
      router.push(`/dashboard/marketing/email-marketing/templates/${t.id}?org=${org.id}`);
    },
    onError: (e) => setMsg(classifyMailError(e).message),
  });

  return (
    <div className="flex flex-col gap-4">
      <EmCard title="Branded email templates" id="em-templates">
        {org.canAuthor && (
          <form className="mb-4 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (name.trim()) create.mutate(); }}>
            <EmField label="Template name"><input value={name} onChange={(e) => setName(e.target.value)} className={emInput} required /></EmField>
            <EmField label="Description"><input value={description} onChange={(e) => setDescription(e.target.value)} className={emInput} /></EmField>
            <button type="submit" className={emBtn} disabled={!name.trim() || create.isPending}>Create template</button>
            <EmMessage message={msg} tone="error" />
          </form>
        )}
        <PermissionBoundary isLoading={q.isLoading} error={q.error} retry={() => q.refetch()}>
          {(q.data?.items ?? []).length === 0 ? (
            <p role="status" className="text-[12px] text-muted-foreground">No templates yet.</p>
          ) : (
            <table className="w-full text-left text-[12px]">
              <thead className="text-muted-foreground"><tr><th className="py-1">Name</th><th>Latest version</th><th>Updated</th></tr></thead>
              <tbody>
                {(q.data?.items ?? []).map((t) => (
                  <tr key={t.id} className="border-t border-border">
                    <td className="py-1.5">
                      <Link className="font-semibold text-primary hover:underline" href={`/dashboard/marketing/email-marketing/templates/${t.id}?org=${org.id}`}>{t.name}</Link>
                      {t.description && <span className="block text-muted-foreground">{t.description}</span>}
                    </td>
                    <td>{t.latestVersion ? `v${t.latestVersion}` : "No versions"}</td>
                    <td className="text-muted-foreground">{formatFullDate(t.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </PermissionBoundary>
      </EmCard>
      <EmCard title="Existing notification email templates (read-only)" id="em-legacy">
        <p className="mb-2 text-[12px] text-muted-foreground">
          These are the existing Marketing &rarr; Email Template records. They remain managed in that section and are unchanged.
        </p>
        <PermissionBoundary isLoading={legacy.isLoading} error={legacy.error} compact>
          {(legacy.data ?? []).length === 0 ? (
            <p className="text-[12px] text-muted-foreground">None.</p>
          ) : (
            <table className="w-full text-left text-[12px]">
              <thead className="text-muted-foreground"><tr><th className="py-1">Event</th><th>Language</th><th>Valid</th><th>Status</th></tr></thead>
              <tbody>
                {(legacy.data ?? []).map((l) => (
                  <tr key={l.id} className="border-t border-border">
                    <td className="py-1">{l.eventName ?? l.eventId}</td>
                    <td>{l.language}</td>
                    <td>{new Date(l.validFrom).toLocaleDateString()} – {new Date(l.validTo).toLocaleDateString()}</td>
                    <td>{l.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </PermissionBoundary>
      </EmCard>
    </div>
  );
}
