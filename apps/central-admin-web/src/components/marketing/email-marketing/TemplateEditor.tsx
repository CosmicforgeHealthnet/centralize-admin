"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Monitor, Smartphone, Trash2 } from "lucide-react";
import PermissionBoundary from "@/components/mail/PermissionBoundary";
import SafeHtmlFrame from "@/components/mail/SafeHtmlFrame";
import { formatFullDate } from "@/components/mail/mail-utils";
import { classifyMailError } from "@/lib/mail.service";
import { approveTemplateVersion, createTemplateVersion, fetchTemplate, renderTemplate } from "@/lib/mail-marketing.service";
import { useAuthStore } from "@/stores/auth.store";
import type { Block, Brand, MarketingOrganization, RenderResult, TemplateClassification, TemplateVersion } from "@/types/mail-marketing.types";
import { EmCard, EmField, EmMessage, emBtn, emBtnOutline, emInput } from "./em-ui";
// Final gaps 1 + 7: classification control, version approval, template QA.
import StepUpDialog from "./StepUpDialog";
import TemplateClassificationControl from "./TemplateClassificationControl";
import TemplateQaPanel from "./TemplateQaPanel";
import { ClassificationBadge } from "./QaStatusBadge";

const VARIABLES = ["first_name", "last_name", "email", "brand_name", "unsubscribe_url"];

const NEW_BLOCKS: Record<Block["type"], Block> = {
  heading: { type: "heading", text: "Heading", level: 1 },
  text: { type: "text", text: "Hello {{first_name}}," },
  button: { type: "button", label: "Learn more", url: "https://" },
  image: { type: "image", src: "https://", alt: "" },
  divider: { type: "divider" },
  spacer: { type: "spacer", height: 24 },
  footer: { type: "footer", text: "You are receiving this because you subscribed." },
};

function BlockFields({ block, onChange }: { block: Block; onChange: (b: Block) => void }) {
  switch (block.type) {
    case "heading":
      return (
        <div className="flex gap-2">
          <input aria-label="Heading text" value={block.text} onChange={(e) => onChange({ ...block, text: e.target.value })} className={emInput} />
          <select aria-label="Heading level" value={block.level ?? 1} onChange={(e) => onChange({ ...block, level: Number(e.target.value) as 1 | 2 | 3 })} className={`${emInput} w-20`}>
            <option value={1}>H1</option><option value={2}>H2</option><option value={3}>H3</option>
          </select>
        </div>
      );
    case "text":
    case "footer":
      return (
        <textarea aria-label={`${block.type} text`} rows={3} value={block.text} onChange={(e) => onChange({ ...block, text: e.target.value })} className={emInput} />
      );
    case "button":
      return (
        <div className="grid grid-cols-2 gap-2">
          <input aria-label="Button label" value={block.label} onChange={(e) => onChange({ ...block, label: e.target.value })} className={emInput} />
          <input aria-label="Button URL" value={block.url} onChange={(e) => onChange({ ...block, url: e.target.value })} className={emInput} />
        </div>
      );
    case "image":
      return (
        <div className="grid grid-cols-2 gap-2">
          <input aria-label="Image URL (https)" value={block.src} onChange={(e) => onChange({ ...block, src: e.target.value })} className={emInput} placeholder="https://…" />
          <input aria-label="Alt text (required)" value={block.alt} onChange={(e) => onChange({ ...block, alt: e.target.value })} className={emInput} placeholder="Alt text (required)" />
          <input aria-label="Image link (optional)" value={block.href ?? ""} onChange={(e) => onChange({ ...block, href: e.target.value || undefined })} className={emInput} placeholder="Link (optional)" />
          <input aria-label="Width (px)" type="number" min={50} max={600} value={block.width ?? 600} onChange={(e) => onChange({ ...block, width: Number(e.target.value) })} className={emInput} />
        </div>
      );
    case "spacer":
      return <input aria-label="Spacer height" type="number" min={4} max={120} value={block.height ?? 24} onChange={(e) => onChange({ ...block, height: Number(e.target.value) })} className={`${emInput} w-28`} />;
    case "divider":
      return <p className="text-[11px] text-muted-foreground">Horizontal divider</p>;
  }
}

export default function TemplateEditor({ org, templateId }: { org: MarketingOrganization; templateId: string }) {
  const qc = useQueryClient();
  const me = useAuthStore((s) => s.user);
  const [approving, setApproving] = useState<TemplateVersion | null>(null);
  const key = ["mail", "marketing", org.id, "template", templateId];
  const q = useQuery({ queryKey: key, queryFn: () => fetchTemplate(org.id, templateId), gcTime: 300000, retry: false });
  const [subject, setSubject] = useState("");
  const [preheader, setPreheader] = useState("");
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [brand, setBrand] = useState<Brand>({ primaryColor: "#272EA7", backgroundColor: "#F4F4F5", brandName: org.name });
  const [loadedVersion, setLoadedVersion] = useState<number | null>(null);
  const [render, setRender] = useState<RenderResult | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [previewTab, setPreviewTab] = useState<"html" | "text">("html");
  const [msg, setMsg] = useState<{ text: string; tone: "info" | "error" } | null>(null);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);

  const loadVersion = (v: TemplateVersion) => {
    setSubject(v.subject);
    setPreheader(v.preheader ?? "");
    setBlocks(v.blocks);
    if (v.brand) setBrand(v.brand);
    setLoadedVersion(v.version);
    setRender(null);
  };

  useEffect(() => {
    const versions = q.data?.versions ?? [];
    if (loadedVersion === null && versions.length) {
      loadVersion([...versions].sort((a, b) => b.version - a.version)[0]);
    } else if (loadedVersion === null && q.data && !versions.length) {
      setBlocks([NEW_BLOCKS.heading, NEW_BLOCKS.text, NEW_BLOCKS.button, NEW_BLOCKS.footer]);
      setLoadedVersion(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data]);

  const preview = useMutation({
    mutationFn: () => renderTemplate(org.id, { subject, blocks, brand, classification: q.data?.classification ?? "MARKETING", sampleData: { first_name: "Ada", last_name: "Lovelace", email: "ada@example.com" } }),
    onSuccess: (r) => {
      setRender(r);
      setRenderError(null);
    },
    onError: (e) => {
      setRender(null);
      setRenderError(classifyMailError(e).message);
    },
  });

  const save = useMutation({
    mutationFn: () => createTemplateVersion(org.id, templateId, { subject, preheader: preheader || undefined, blocks, brand }),
    onSuccess: (v) => {
      setLoadedVersion(v.version);
      setMsg({ text: `Saved as immutable version ${v.version}.`, tone: "info" });
      qc.invalidateQueries({ queryKey: key });
      qc.invalidateQueries({ queryKey: ["mail", "marketing", org.id, "templates"] });
    },
    onError: (e) => setMsg({ text: classifyMailError(e).message, tone: "error" }),
  });

  const approveVersion = useMutation({
    mutationFn: ({ version, stepUpId }: { version: TemplateVersion; stepUpId: string }) => approveTemplateVersion(org.id, templateId, version.id, { stepUpId }),
    onSuccess: () => {
      setApproving(null);
      setMsg({ text: "Version approved.", tone: "info" });
      qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => {
      setApproving(null);
      setMsg({ text: classifyMailError(e).message, tone: "error" });
    },
  });

  const update = (i: number, b: Block) => setBlocks((bs) => bs.map((x, j) => (j === i ? b : x)));
  const moveBlock = (i: number, d: -1 | 1) =>
    setBlocks((bs) => {
      const n = [...bs];
      const t = i + d;
      if (t < 0 || t >= n.length) return bs;
      [n[i], n[t]] = [n[t], n[i]];
      return n;
    });
  const insertVariable = (v: string) => {
    const i = focusIndex;
    if (i === null) {
      setSubject((s) => `${s}{{${v}}}`);
      return;
    }
    const b = blocks[i];
    if (b && (b.type === "text" || b.type === "footer" || b.type === "heading")) update(i, { ...b, text: `${b.text}{{${v}}}` });
  };

  if (!q.data) {
    return (
      <EmCard>
        <PermissionBoundary isLoading={q.isLoading} error={q.error} retry={() => q.refetch()}>{null}</PermissionBoundary>
      </EmCard>
    );
  }
  const canEdit = org.canAuthor;
  const versions = [...(q.data.versions ?? [])].sort((a, b) => b.version - a.version);
  const a11y = Array.isArray(render?.accessibility) ? render?.accessibility : [];
  const classification: TemplateClassification = q.data.classification ?? "MARKETING";
  // {{unsubscribe_url}} is a marketing-only variable.
  const variables = classification === "MARKETING" ? VARIABLES : VARIABLES.filter((v) => v !== "unsubscribe_url");
  const qaVersion = versions.find((v) => v.version === loadedVersion) ?? versions[0] ?? null;

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_1fr]">
      <div className="flex flex-col gap-4">
        <EmCard title={q.data.name} id="te-name" actions={<span className="text-[11px] text-muted-foreground">{loadedVersion ? `Editing from v${loadedVersion}` : "New template"}</span>}>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <EmField label="Subject"><input value={subject} disabled={!canEdit} onChange={(e) => setSubject(e.target.value)} onFocus={() => setFocusIndex(null)} className={emInput} /></EmField>
            <EmField label="Preheader"><input value={preheader} disabled={!canEdit} onChange={(e) => setPreheader(e.target.value)} className={emInput} /></EmField>
            <EmField label="Brand colour"><input type="color" value={brand.primaryColor ?? "#272EA7"} disabled={!canEdit} onChange={(e) => setBrand((b) => ({ ...b, primaryColor: e.target.value }))} className="h-9 w-16 rounded border border-border" /></EmField>
            <EmField label="Background colour"><input type="color" value={brand.backgroundColor ?? "#F4F4F5"} disabled={!canEdit} onChange={(e) => setBrand((b) => ({ ...b, backgroundColor: e.target.value }))} className="h-9 w-16 rounded border border-border" /></EmField>
            <EmField label="Brand name"><input value={brand.brandName ?? ""} disabled={!canEdit} onChange={(e) => setBrand((b) => ({ ...b, brandName: e.target.value }))} className={emInput} /></EmField>
            <EmField label="Logo URL (https)"><input value={brand.logoUrl ?? ""} disabled={!canEdit} onChange={(e) => setBrand((b) => ({ ...b, logoUrl: e.target.value || undefined }))} className={emInput} /></EmField>
          </div>
          <div className="mt-3">
            <TemplateClassificationControl
              org={org}
              templateId={templateId}
              classification={classification}
              available={q.data.classificationAvailable !== false}
              onChanged={() => {
                setLoadedVersion(null);
                qc.invalidateQueries({ queryKey: key });
                qc.invalidateQueries({ queryKey: ["mail", "marketing", org.id, "templates"] });
              }}
            />
          </div>
          <div className="mt-3">
            <p className="mb-1 text-[11px] font-semibold text-muted-foreground">Personalization variables (inserted into the focused block, or subject)</p>
            <div className="flex flex-wrap gap-1">
              {variables.map((v) => (
                <button key={v} type="button" disabled={!canEdit} onClick={() => insertVariable(v)} className="rounded-full border border-border px-2 py-0.5 font-mono text-[11px] hover:bg-muted">
                  {`{{${v}}}`}
                </button>
              ))}
            </div>
          </div>
        </EmCard>

        <EmCard title="Content blocks" id="te-blocks">
          <ol className="flex flex-col gap-2">
            {blocks.map((b, i) => (
              <li key={i} className={`rounded-md border p-2 ${focusIndex === i ? "border-primary" : "border-border"}`} onFocusCapture={() => setFocusIndex(i)}>
                <div className="mb-1 flex items-center gap-1">
                  <span className="text-[11px] font-semibold uppercase text-muted-foreground">{b.type}</span>
                  {canEdit && (
                    <span className="ml-auto flex gap-1">
                      <button type="button" aria-label="Move block up" onClick={() => moveBlock(i, -1)} className="rounded p-1 hover:bg-muted"><ArrowUp className="h-3.5 w-3.5" /></button>
                      <button type="button" aria-label="Move block down" onClick={() => moveBlock(i, 1)} className="rounded p-1 hover:bg-muted"><ArrowDown className="h-3.5 w-3.5" /></button>
                      <button type="button" aria-label="Delete block" onClick={() => setBlocks((bs) => bs.filter((_, j) => j !== i))} className="rounded p-1 hover:bg-muted"><Trash2 className="h-3.5 w-3.5" /></button>
                    </span>
                  )}
                </div>
                <fieldset disabled={!canEdit}>
                  <BlockFields block={b} onChange={(nb) => update(i, nb)} />
                </fieldset>
              </li>
            ))}
          </ol>
          {canEdit && (
            <div className="mt-3 flex flex-wrap gap-1">
              {(Object.keys(NEW_BLOCKS) as Block["type"][]).map((t) => (
                <button key={t} type="button" className={emBtnOutline} onClick={() => setBlocks((bs) => [...bs, { ...NEW_BLOCKS[t] } as Block])}>
                  + {t}
                </button>
              ))}
            </div>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button type="button" className={emBtnOutline} onClick={() => preview.mutate()} disabled={preview.isPending || !blocks.length}>
              {preview.isPending ? "Rendering…" : "Preview / test render"}
            </button>
            {canEdit && (
              <button type="button" className={emBtn} onClick={() => save.mutate()} disabled={save.isPending || !subject.trim() || !blocks.length}>
                Save as new version
              </button>
            )}
            {msg && <EmMessage message={msg.text} tone={msg.tone} />}
          </div>
        </EmCard>

        <EmCard title="Version history" id="te-versions">
          {versions.length === 0 ? (
            <p className="text-[12px] text-muted-foreground">No saved versions. Versions are immutable once saved.</p>
          ) : (
            <ul className="flex flex-col gap-1 text-[12px]">
              {versions.map((v) => (
                <li key={v.id} className="flex items-center gap-2 border-t border-border py-1">
                  <span className="font-semibold">v{v.version}</span>
                  {v.classification && <ClassificationBadge value={v.classification} />}
                  <span className="flex-1 truncate">{v.subject}</span>
                  {v.classification && v.classification !== "MARKETING" && (
                    v.approval?.approved ? (
                      <span className="text-[11px] text-emerald-700">Approved</span>
                    ) : org.canApprove && v.createdBy !== me?.id ? (
                      <button type="button" className="text-primary hover:underline" onClick={() => setApproving(v)}>Approve</button>
                    ) : (
                      <span className="text-[11px] text-amber-700">{v.classification === "TRANSACTIONAL_SECURITY" ? "Needs second approver" : "Not approved"}</span>
                    )
                  )}
                  <span className="text-muted-foreground">{formatFullDate(v.createdAt)}</span>
                  <button type="button" className="text-primary hover:underline" onClick={() => loadVersion(v)}>Load</button>
                </li>
              ))}
            </ul>
          )}
        </EmCard>
      </div>

      <div className="flex flex-col gap-4">
      <EmCard
        title="Preview"
        id="te-preview"
        actions={
          <div className="flex gap-1" role="group" aria-label="Preview options">
            <button type="button" aria-pressed={device === "desktop"} onClick={() => setDevice("desktop")} className={`rounded p-1.5 ${device === "desktop" ? "bg-primary/10" : "hover:bg-muted"}`} aria-label="Desktop preview"><Monitor className="h-4 w-4" /></button>
            <button type="button" aria-pressed={device === "mobile"} onClick={() => setDevice("mobile")} className={`rounded p-1.5 ${device === "mobile" ? "bg-primary/10" : "hover:bg-muted"}`} aria-label="Mobile preview"><Smartphone className="h-4 w-4" /></button>
            <button type="button" aria-pressed={previewTab === "html"} onClick={() => setPreviewTab("html")} className={`rounded px-2 text-[11px] ${previewTab === "html" ? "bg-primary/10 font-semibold" : "hover:bg-muted"}`}>HTML</button>
            <button type="button" aria-pressed={previewTab === "text"} onClick={() => setPreviewTab("text")} className={`rounded px-2 text-[11px] ${previewTab === "text" ? "bg-primary/10 font-semibold" : "hover:bg-muted"}`}>Plain text</button>
          </div>
        }
      >
        {renderError && <EmMessage message={renderError} tone="error" />}
        {!render ? (
          <p className="text-[12px] text-muted-foreground">Run “Preview / test render” to see the server-rendered, sanitized email.</p>
        ) : (
          <div className="flex flex-col gap-3">
            <div className={device === "mobile" ? "mx-auto w-[375px] max-w-full" : "w-full"}>
              {previewTab === "html" ? (
                <SafeHtmlFrame html={render.html} title="Email preview" minHeight={480} allowRemoteImages={classification !== "TRANSACTIONAL_SECURITY"} />
              ) : (
                <pre className="max-h-[480px] overflow-auto whitespace-pre-wrap rounded border border-border p-3 font-mono text-[12px]">{render.text}</pre>
              )}
            </div>
            {render.warnings.length > 0 && (
              <ul className="text-[12px] text-amber-700" aria-label="Warnings">
                {render.warnings.map((w, i) => <li key={i}>⚠ {w}</li>)}
              </ul>
            )}
            {a11y && a11y.length > 0 && (
              <ul className="text-[12px]" aria-label="Accessibility checks">
                {a11y.map((c, i) => (
                  <li key={i} className={c.ok === false ? "text-red-600" : "text-muted-foreground"}>
                    {c.ok === false ? "✗" : "✓"} {c.detail ?? c.message ?? c.id}
                  </li>
                ))}
              </ul>
            )}
            <p className="text-[11px] text-muted-foreground">Variables used: {render.variables.join(", ") || "none"}</p>
          </div>
        )}
      </EmCard>
      <TemplateQaPanel key={qaVersion?.id ?? "none"} org={org} templateId={templateId} version={qaVersion} />
      </div>
      {approving && (
        <StepUpDialog
          purpose="MARKETING_TEMPLATE_APPROVE"
          title={`Approve template version v${approving.version}`}
          onCancel={() => setApproving(null)}
          onVerified={(stepUpId) => approveVersion.mutateAsync({ version: approving, stepUpId }).then(() => undefined)}
        />
      )}
    </div>
  );
}
