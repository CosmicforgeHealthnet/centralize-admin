// src/components/marketing/email-template/EventView.tsx
"use client";

import { useState, useEffect } from "react";
import {
  ArrowLeft, Search, Edit2, Trash2, X, AlignLeft, AlignCenter, AlignRight,
  AlignJustify, Bold, Italic, Underline, List, Paperclip, Link2, Save, PlusCircle,
} from "lucide-react";
import { useMarketingStore } from "@/stores/marketing.store";
import { Skeleton } from "@/components/ui/skeleton";

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`w-9 h-5 rounded-full flex items-center px-0.5 transition-colors ${checked ? "bg-primary justify-end" : "bg-muted-foreground/30 justify-start"}`}
    >
      <span className="w-4 h-4 rounded-full bg-white shadow" />
    </button>
  );
}

function Chip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 bg-muted px-2.5 py-1 rounded-full text-[11px] font-poppins text-foreground">
      {label}
      <button onClick={onRemove} className="text-muted-foreground hover:text-red-500 transition-colors">
        <X className="w-3 h-3" />
      </button>
    </span>
  );
}

interface Props {
  templateId: string;
  onBack: () => void;
}

export default function EventView({ templateId, onBack }: Props) {
  const [notifyEnabled, setNotifyEnabled] = useState(true);
  const [emailEnabled, setEmailEnabled] = useState(true);
  const [whatsappEnabled, setWhatsappEnabled] = useState(true);
  const [smsEnabled, setSmsEnabled] = useState(true);
  const [recipients, setRecipients] = useState<string[]>([]);
  const [isSaving, setIsSaving] = useState(false);

  const {
    selectedEmailTemplate,
    isLoadingEmailTemplateDetail,
    fetchEmailTemplateDetail,
    updateEmailTemplateNotification,
    updateEmailTemplateRecipients,
    updateEmailTemplateContent,
    error,
    clearError,
  } = useMarketingStore();

  useEffect(() => {
    if (templateId) {
      fetchEmailTemplateDetail(templateId);
    }
  }, [templateId, fetchEmailTemplateDetail]);

  useEffect(() => {
    if (error) {
      const timer = setTimeout(() => clearError(), 5000);
      return () => clearTimeout(timer);
    }
  }, [error, clearError]);

  function toggleRecipient(r: string) {
    setRecipients((prev) => (prev.includes(r) ? prev.filter((x) => x !== r) : [...prev, r]));
  }

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await updateEmailTemplateNotification(templateId, notifyEnabled);
      await updateEmailTemplateRecipients(templateId, {
        channels: {
          email: emailEnabled,
          whatsapp: whatsappEnabled,
          sms: smsEnabled,
        },
        recipients: recipients as any[], // Type cast needed
      });
      // Content update would go here with proper payload
      setIsSaving(false);
      onBack();
    } catch (err) {
      setIsSaving(false);
    }
  };

  if (isLoadingEmailTemplateDetail || !selectedEmailTemplate) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-[60px] w-full rounded-xl" />
        <Skeleton className="h-[200px] w-full rounded-xl" />
        <Skeleton className="h-[300px] w-full rounded-xl" />
        <Skeleton className="h-[400px] w-full rounded-xl" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <p className="text-red-500 text-sm">{error}</p>
        <button onClick={onBack} className="mt-4 text-primary hover:underline">
          Go back
        </button>
      </div>
    );
  }

  const template = selectedEmailTemplate;

  return (
    <div className="flex flex-col gap-4">
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 text-muted-foreground hover:text-primary transition-colors w-fit"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        <span className="font-poppins text-[12px] font-medium">Email Template</span>
      </button>

      <h2 className="font-poppins text-[16px] font-semibold text-foreground">
        Event {template.eventCode}
      </h2>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
          {error}
        </div>
      )}

      <div className="bg-card rounded-xl border border-border p-4 flex items-center gap-3">
        <Toggle checked={notifyEnabled} onChange={setNotifyEnabled} />
        <div>
          <p className="font-poppins text-[13px] font-medium text-foreground">Raise a notification for this event</p>
          <p className="font-poppins text-[11px] text-muted-foreground">This broadcasts notification</p>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-6 flex-wrap">
          <h3 className="font-poppins text-[14px] font-semibold text-foreground">Recipients</h3>
          <label className="flex items-center gap-2 cursor-pointer">
            <Toggle checked={emailEnabled} onChange={setEmailEnabled} />
            <span className="font-poppins text-[12px] text-foreground">Email</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <Toggle checked={whatsappEnabled} onChange={setWhatsappEnabled} />
            <span className="font-poppins text-[12px] text-foreground">Whatsapp</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <Toggle checked={smsEnabled} onChange={setSmsEnabled} />
            <span className="font-poppins text-[12px] text-foreground">SMS</span>
          </label>
        </div>

        <div className="bg-primary/8 rounded-lg p-4 flex flex-col gap-2.5">
          {["Customer", "Recipients", "Admin"].map((r) => (
            <label key={r} className="flex items-center gap-2.5 cursor-pointer w-fit">
              <input
                type="checkbox"
                checked={recipients.includes(r)}
                onChange={() => toggleRecipient(r)}
                className="w-4 h-4 rounded border-border accent-primary"
              />
              <span className="font-poppins text-[13px] text-foreground">{r}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5">
          <h3 className="font-poppins text-[14px] font-semibold text-foreground">Templates</h3>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-2 bg-muted border border-border rounded-lg px-3 h-[36px] min-w-[160px]">
              <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <input
                placeholder="Search here..."
                className="bg-transparent text-[12px] font-poppins text-foreground outline-none w-full placeholder:text-muted-foreground"
              />
            </div>
            <button className="px-4 py-2 bg-primary text-white text-[12px] font-poppins font-semibold rounded-lg hover:bg-primary/90 transition-colors h-[36px]">
              Search
            </button>
            <button className="px-4 py-2 bg-primary text-white text-[12px] font-poppins font-semibold rounded-lg hover:bg-primary/90 transition-colors h-[36px] flex items-center gap-1.5">
              <PlusCircle className="w-3.5 h-3.5" />
              Create Content
            </button>
          </div>
        </div>

        <div className="bg-card rounded-xl border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px]">
              <thead>
                <tr className="border-b border-border bg-muted/40">
                  <th className="w-10 py-2.5 px-4" />
                  {["Valid from date", "Valid to date", "Language", "Status", "Action"].map((h) => (
                    <th key={h} className="text-left py-2.5 px-4 text-[12px] font-poppins font-semibold text-muted-foreground whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {template.templates && template.templates.length > 0 ? (
                  template.templates.map((t) => (
                    <tr key={t.id} className="border-b border-border/50">
                      <td className="py-3 px-4">
                        <input type="checkbox" className="w-4 h-4 rounded border-border accent-primary" />
                      </td>
                      <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">
                        {t.validFrom || "—"}
                      </td>
                      <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">
                        {t.validTo || "—"}
                      </td>
                      <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">
                        {t.language || "EN"}
                      </td>
                      <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">
                        {t.status || "Active"}
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-2.5">
                          <button className="text-primary hover:text-primary/70 transition-colors">
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>
                          <button className="text-red-500 hover:text-red-400 transition-colors">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={6} className="text-center py-8 text-muted-foreground text-sm">
                      No template versions found
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="bg-card rounded-xl border border-border p-4">
          <h4 className="font-poppins text-[13px] font-semibold text-foreground mb-3">Customers</h4>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {[
              { label: "Full Name:", value: template.customer?.fullName || "—" },
              { label: "Email:", value: template.customer?.email || "—" },
              { label: "Phone Number:", value: template.customer?.phone || "—" },
              { label: "Country:", value: template.customer?.country || "—" },
            ].map(({ label, value }) => (
              <div key={label} className="flex flex-col gap-0.5">
                <span className="font-poppins text-[10px] text-muted-foreground">{label}</span>
                <span className="font-poppins text-[12px] font-semibold text-foreground">{value}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="font-poppins text-[14px] font-semibold text-foreground">Templates</h3>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h4 className="font-poppins text-[13px] font-semibold text-foreground">Email</h4>
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="font-poppins text-[12px] text-foreground">Hello</span>
              <Chip label="Name" onRemove={() => {}} />
              <Chip label="Surname" onRemove={() => {}} />
            </div>
          </div>

          <div className="bg-card rounded-xl border border-border overflow-hidden">
            <div className="flex items-center gap-3 px-3 py-2 border-b border-border overflow-x-auto">
              {[AlignLeft, AlignCenter, AlignRight, AlignJustify, Bold, Italic, Underline, List, Paperclip, Link2].map((Icon, i) => (
                <button key={i} className="text-muted-foreground hover:text-foreground transition-colors shrink-0">
                  <Icon className="w-4 h-4" />
                </button>
              ))}
            </div>
            <div className="p-4 flex flex-col gap-3">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="font-poppins text-[12px] text-foreground">Hello</span>
                <Chip label="Name" onRemove={() => {}} />
                <Chip label="Surname" onRemove={() => {}} />
              </div>
              <p className="font-poppins text-[12px] text-foreground">
                {template.emailContent?.body || "Your order is currently being processed."}
              </p>
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="font-poppins text-[12px] text-foreground">Tracking Number:</span>
                <Chip label="Order Tracking Number" onRemove={() => {}} />
              </div>
              {template.conditionalBlock && (
                <div className="bg-primary/8 rounded-lg p-3 flex items-start justify-between gap-2">
                  <div>
                    <p className="font-poppins text-[12px] text-foreground">
                      If {template.conditionalBlock.condition}
                    </p>
                    <p className="font-poppins text-[12px] text-foreground mt-1">
                      {template.conditionalBlock.message}
                    </p>
                  </div>
                  <button className="text-muted-foreground hover:text-primary transition-colors shrink-0">
                    <Edit2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <h4 className="font-poppins text-[13px] font-semibold text-foreground">Whatsapp / SMS</h4>
          <div className="bg-card rounded-xl border border-border overflow-hidden">
            <div className="flex items-center gap-3 px-3 py-2 border-b border-border">
              <button className="text-muted-foreground hover:text-foreground transition-colors">
                <Link2 className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 flex flex-col gap-3">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="font-poppins text-[12px] text-foreground">Hello</span>
                <Chip label="Name" onRemove={() => {}} />
                <Chip label="Surname" onRemove={() => {}} />
              </div>
              <p className="font-poppins text-[12px] text-foreground">
                {template.whatsappContent?.body || "Your order is currently being processed."}
              </p>
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="font-poppins text-[12px] text-foreground">Tracking Number:</span>
                <Chip label="Order Tracking Number" onRemove={() => {}} />
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={isSaving}
          className="px-10 py-3 bg-primary text-white text-[13px] font-poppins font-semibold rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          <Save className="w-4 h-4" />
          {isSaving ? "Saving..." : "Save"}
        </button>
        <button
          onClick={onBack}
          className="px-10 py-3 border border-border rounded-lg text-[13px] font-poppins font-semibold text-foreground hover:bg-muted/50 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}