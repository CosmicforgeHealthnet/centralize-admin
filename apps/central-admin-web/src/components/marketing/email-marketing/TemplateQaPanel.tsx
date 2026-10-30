"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import SafeHtmlFrame from "@/components/mail/SafeHtmlFrame";
import { classifyMailError } from "@/lib/mail.service";
import { runTemplateQa } from "@/lib/mail-marketing.service";
import type { MarketingOrganization, PreflightStatus, TemplateQaReport, TemplateVersion } from "@/types/mail-marketing.types";
import { ClassificationBadge, QaStatusBadge } from "./QaStatusBadge";
import { EmCard, EmField, EmMessage, emBtnOutline, emInput } from "./em-ui";

type Tab = "desktop" | "mobile" | "dark" | "plaintext";
const TABS: { id: Tab; label: string }[] = [
  { id: "desktop", label: "Desktop" },
  { id: "mobile", label: "Mobile" },
  { id: "dark", label: "Dark mode" },
  { id: "plaintext", label: "Plain text" },
];
const ORDER: PreflightStatus[] = ["BLOCKED", "WARNING", "UNKNOWN", "PASS"];

/** Template QA for one saved version: previews + static checks (server-side, no URL is fetched). */
export default function TemplateQaPanel({ org, templateId, version }: { org: MarketingOrganization; templateId: string; version: TemplateVersion | null }) {
  const [locale, setLocale] = useState("en-GB");
  const [tab, setTab] = useState<Tab>("desktop");
  const [report, setReport] = useState<TemplateQaReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const qa = useMutation({
    mutationFn: () => runTemplateQa(org.id, templateId, version?.id ?? "", { locale }),
    onSuccess: (r) => {
      setReport(r);
      setError(null);
    },
    onError: (e) => {
      setReport(null);
      setError(classifyMailError(e).message);
    },
  });

  // Security templates may not contain remote images: never load them in the preview.
  const allowRemoteImages = report?.classification !== "TRANSACTIONAL_SECURITY";
  const checks = [...(report?.checks ?? [])].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));

  return (
    <EmCard
      title="Template QA"
      id="te-qa"
      actions={
        <div className="flex items-end gap-2">
          <EmField label="Locale">
            <input aria-label="QA locale" value={locale} onChange={(e) => setLocale(e.target.value)} className={`${emInput} w-24`} />
          </EmField>
          <button type="button" className={emBtnOutline} onClick={() => qa.mutate()} disabled={!version || qa.isPending}>
            {qa.isPending ? "Checking…" : version ? `Run QA on v${version.version}` : "Save a version first"}
          </button>
        </div>
      }
    >
      {error && <EmMessage message={error} tone="error" />}
      {!report ? (
        <p className="text-[12px] text-muted-foreground">QA renders the saved version for desktop, mobile, dark mode and plain text, and checks accessibility, personalization, links (offline) and email-client compatibility.</p>
      ) : (
        <div className="flex flex-col gap-3" data-testid="template-qa-report">
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <ClassificationBadge value={report.classification} />
            {ORDER.map((s) => (
              <span key={s} className="inline-flex items-center gap-1"><QaStatusBadge status={s} /> {report.summary[s] ?? 0}</span>
            ))}
          </div>
          <p role="note" className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-800">{report.disclaimer}</p>
          {report.renders && (
            <>
              <div role="tablist" aria-label="QA previews" className="flex gap-1">
                {TABS.map((t) => (
                  <button key={t.id} role="tab" type="button" aria-selected={tab === t.id} onClick={() => setTab(t.id)} className={`rounded px-2 py-1 text-[11px] ${tab === t.id ? "bg-primary/10 font-semibold" : "hover:bg-muted"}`}>
                    {t.label}
                  </button>
                ))}
              </div>
              <div role="tabpanel" className={tab === "mobile" ? "mx-auto w-[375px] max-w-full" : "w-full"}>
                {tab === "plaintext" ? (
                  <pre className="max-h-[480px] overflow-auto whitespace-pre-wrap rounded border border-border p-3 font-mono text-[12px]">{report.renders.plaintext}</pre>
                ) : (
                  <SafeHtmlFrame
                    html={tab === "dark" ? report.renders.dark.html : tab === "mobile" ? report.renders.mobile.html : report.renders.desktop.html}
                    title={`QA preview (${tab})`}
                    minHeight={420}
                    allowRemoteImages={allowRemoteImages}
                  />
                )}
              </div>
              {tab === "dark" && (
                <p className="text-[11px] text-muted-foreground">
                  {report.renders.dark.supportsDarkMode ? "The template declares dark-mode styles." : "Simulated forced dark mode: the template has no dark-mode styles, so clients invert colours themselves."}
                </p>
              )}
              <p className="text-[11px] text-muted-foreground">
                Locale {report.locale}: {report.formatted.date} · {report.formatted.number} · {report.formatted.currency}. Subject: {report.renders.subject}
              </p>
            </>
          )}
          <ul className="flex flex-col gap-1 text-[12px]" aria-label="QA checks">
            {checks.map((c) => (
              <li key={c.id} className="flex items-start gap-2">
                <QaStatusBadge status={c.status} />
                <span><span className="font-semibold">{c.id}</span> — {c.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </EmCard>
  );
}
