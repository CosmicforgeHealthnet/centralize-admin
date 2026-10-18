"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import { CreditCard, Phone, Mail, MapPin, Calendar } from "lucide-react";
import { useHealthnetStore } from "@/stores/healthnet.store";
import PharmacyDocumentsTab from "@/components/healthnet/pharmacy/PharmacyDocumentsTab";
import PharmacyOtherInfoTab from "@/components/healthnet/pharmacy/PharmacyOtherInfoTab";

type Tab = "documents" | "otherInfo";
const TABS: { label: string; value: Tab }[] = [
  { label: "Documents", value: "documents" },
  { label: "Other Info", value: "otherInfo" },
];

const DAYS = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"];

function HoursDisplay({ hours }: { hours?: string | null }) {
  if (!hours) return <span className="text-[12px] font-poppins font-bold text-foreground">—</span>;
  let parsed: Record<string, string> | null = null;
  try {
    const val = typeof hours === "string" ? JSON.parse(hours) : hours;
    if (typeof val === "object" && val !== null) parsed = val;
  } catch { /* plain string */ }
  if (!parsed) return <span className="text-[12px] font-poppins font-bold text-foreground">{hours}</span>;
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-2">
      {DAYS.map((day) => {
        const val = parsed![day];
        if (!val) return null;
        const closed = val === "closed";
        return (
          <div key={day} className="flex items-center gap-3">
            <span className="text-[11px] font-poppins font-semibold text-muted-foreground capitalize w-7 shrink-0">{day.slice(0, 3)}</span>
            <span className={`text-[11px] font-poppins font-bold ${closed ? "text-destructive" : "text-foreground"}`}>{closed ? "Closed" : val}</span>
          </div>
        );
      })}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const isPending = status === "pending";
  const isActive = status === "active" || status === "approved";
  return (
    <div className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-poppins font-semibold ${
      isPending 
        ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300" 
        : isActive 
          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300" 
          : "bg-destructive/10 text-destructive"
    }`}>
      <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
        isPending ? "bg-amber-500 text-white" : 
        isActive ? "bg-emerald-500 text-white" : 
        "bg-destructive text-white"
      }`}>
        {status.charAt(0).toUpperCase()}
      </span>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </div>
  );
}

function InfoRow({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: string | null | undefined }) {
  return (
    <div className="flex items-start gap-3">
      <div className="w-7 h-7 rounded-[6px] bg-secondary flex items-center justify-center shrink-0 mt-0.5">
        <Icon className="w-3.5 h-3.5 text-primary" />
      </div>
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="text-[10px] font-poppins text-muted-foreground">{label}</span>
        <span className="text-[12px] font-poppins font-semibold text-foreground break-words">{value ?? "—"}</span>
      </div>
    </div>
  );
}

/* ── Skeletons ── */
function LeftPanelSkeleton() {
  return (
    <div className="w-full lg:w-[240px] shrink-0 flex flex-col gap-4">
      <div className="bg-card rounded-[16px] shadow-[0_1px_20px_0_rgba(0,0,0,0.06)] dark:shadow-[0_1px_20px_0_rgba(0,0,0,0.3)] overflow-hidden">
        <div className="w-full aspect-[4/3] bg-muted animate-pulse" />
      </div>
      <div className="bg-card rounded-[16px] shadow-[0_1px_20px_0_rgba(0,0,0,0.06)] dark:shadow-[0_1px_20px_0_rgba(0,0,0,0.3)] p-4 flex flex-col gap-3">
        <div className="h-4 w-28 bg-muted rounded animate-pulse" />
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3">
            <div className="w-7 h-7 rounded-[6px] bg-muted animate-pulse shrink-0" />
            <div className="flex flex-col gap-1 flex-1">
              <div className="h-2.5 w-16 bg-muted rounded animate-pulse" />
              <div className="h-3 w-32 bg-muted rounded animate-pulse" />
            </div>
          </div>
        ))}
      </div>
      <div className="bg-card rounded-[16px] shadow-[0_1px_20px_0_rgba(0,0,0,0.06)] dark:shadow-[0_1px_20px_0_rgba(0,0,0,0.3)] p-4 flex flex-col gap-2">
        <div className="h-4 w-12 bg-muted rounded animate-pulse" />
        <div className="h-7 w-24 bg-muted rounded-full animate-pulse" />
      </div>
    </div>
  );
}

function RightPanelSkeleton() {
  return (
    <div className="flex-1 min-w-0 flex flex-col gap-5">
      {[0, 1, 2].map((i) => (
        <div key={i} className="bg-card rounded-[16px] shadow-[0_1px_20px_0_rgba(0,0,0,0.06)] dark:shadow-[0_1px_20px_0_rgba(0,0,0,0.3)] p-5">
          <div className="h-4 w-36 bg-muted rounded animate-pulse mb-4" />
          <div className="grid grid-cols-3 gap-6">
            {Array.from({ length: i === 0 ? 3 : 1 }).map((_, j) => (
              <div key={j} className="flex flex-col gap-1.5">
                <div className="h-2.5 w-24 bg-muted rounded animate-pulse" />
                <div className="h-3.5 w-32 bg-muted rounded animate-pulse" />
              </div>
            ))}
          </div>
        </div>
      ))}
      <div className="bg-card rounded-[16px] shadow-[0_1px_20px_0_rgba(0,0,0,0.06)] dark:shadow-[0_1px_20px_0_rgba(0,0,0,0.3)] overflow-hidden">
        <div className="flex border-b border-border px-5 gap-6 py-4">
          <div className="h-4 w-20 bg-muted rounded animate-pulse" />
          <div className="h-4 w-20 bg-muted rounded animate-pulse" />
        </div>
        <div className="p-5 grid grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="rounded-[12px] overflow-hidden border border-border">
              <div className="w-full h-[160px] bg-muted animate-pulse" />
              <div className="p-3 flex flex-col gap-1.5">
                <div className="h-3 w-24 bg-muted rounded animate-pulse" />
                <div className="h-2.5 w-16 bg-muted rounded animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function DocumentsSkeleton() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="rounded-[12px] overflow-hidden border border-border">
          <div className="w-full h-[160px] bg-muted animate-pulse" />
          <div className="p-3 flex flex-col gap-1.5">
            <div className="h-3 w-24 bg-muted rounded animate-pulse" />
            <div className="h-2.5 w-16 bg-muted rounded animate-pulse" />
          </div>
        </div>
      ))}
    </div>
  );
}

function StaffSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i}>
          <div className="h-3.5 w-32 bg-muted rounded animate-pulse mb-3" />
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2.5">
            {Array.from({ length: 4 }).map((_, j) => (
              <div key={j} className="flex items-center gap-2.5 p-2.5 rounded-[10px] border border-border">
                <div className="w-9 h-9 rounded-full bg-muted animate-pulse shrink-0" />
                <div className="flex flex-col gap-1.5 flex-1">
                  <div className="h-3 w-20 bg-muted rounded animate-pulse" />
                  <div className="h-2.5 w-16 bg-muted rounded animate-pulse" />
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function PharmacyProfileDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const [activeTab, setActiveTab] = useState<Tab>("documents");
  const {
    pharmacyDetail, pharmacyDetailLoading, pharmacyDetailError, fetchPharmacyById,
    pharmacyDocuments, pharmacyDocumentsLoading, fetchPharmacyDocuments,
    pharmacyStaff, pharmacyStaffLoading, fetchPharmacyStaff,
  } = useHealthnetStore();

  useEffect(() => {
    fetchPharmacyById(id);
    fetchPharmacyDocuments(id);
    fetchPharmacyStaff(id);
  }, [id]);

  if (pharmacyDetailError) {
    return (
      <div className="py-20 text-center">
        <p className="text-[13px] font-poppins text-destructive">{pharmacyDetailError}</p>
        <button onClick={onBack} className="mt-4 text-[13px] font-poppins text-primary underline">Go back</button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-[20px] font-poppins font-bold text-foreground -mt-2">Pharmacy Profile Details</h1>
      <div className="flex flex-col lg:flex-row gap-5 items-start">

        {/* ── Left panel ── */}
        {pharmacyDetailLoading ? <LeftPanelSkeleton /> : (
          <div className="w-full lg:w-[240px] shrink-0 flex flex-col gap-4">
            <div className="bg-card rounded-[16px] shadow-[0_1px_20px_0_rgba(0,0,0,0.06)] dark:shadow-[0_1px_20px_0_rgba(0,0,0,0.3)] overflow-hidden">
              <div className="w-full aspect-[4/3] bg-muted relative">
                {pharmacyDetail?.avatarUrl ? (
                  <Image 
                    src={pharmacyDetail.avatarUrl} 
                    alt={pharmacyDetail.businessName ?? "Pharmacy"} 
                    fill 
                    className="object-cover"
                    onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} 
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <span className="text-[32px] font-poppins font-bold text-muted-foreground">
                      {pharmacyDetail?.businessName?.charAt(0) ?? "P"}
                    </span>
                  </div>
                )}
              </div>
            </div>
            <div className="bg-card rounded-[16px] shadow-[0_1px_20px_0_rgba(0,0,0,0.06)] dark:shadow-[0_1px_20px_0_rgba(0,0,0,0.3)] p-4 flex flex-col gap-3">
              <p className="text-[13px] font-poppins font-bold text-foreground">Contact Details</p>
              <InfoRow icon={CreditCard} label="Full Name:" value={pharmacyDetail?.contactName} />
              <InfoRow icon={Phone} label="Phone Number:" value={pharmacyDetail?.phone} />
              <InfoRow icon={Mail} label="Email Address:" value={pharmacyDetail?.email} />
              <InfoRow icon={MapPin} label="Location:" value={pharmacyDetail?.location} />
              <InfoRow icon={Calendar} label="Registration Date:" value={pharmacyDetail?.registrationDate} />
            </div>
            <div className="bg-card rounded-[16px] shadow-[0_1px_20px_0_rgba(0,0,0,0.06)] dark:shadow-[0_1px_20px_0_rgba(0,0,0,0.3)] p-4 flex flex-col gap-2">
              <p className="text-[13px] font-poppins font-bold text-foreground">Status</p>
              <StatusBadge status={pharmacyDetail?.status ?? "pending"} />
            </div>
          </div>
        )}

        {/* ── Right panel ── */}
        {pharmacyDetailLoading ? <RightPanelSkeleton /> : (
          <div className="flex-1 min-w-0 flex flex-col gap-5">
            {/* Business Information */}
            <div className="bg-card rounded-[16px] shadow-[0_1px_20px_0_rgba(0,0,0,0.06)] dark:shadow-[0_1px_20px_0_rgba(0,0,0,0.3)] p-5">
              <p className="text-[15px] font-poppins font-bold text-foreground mb-4">Business Information</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-4 mb-4">
                <div className="flex flex-col gap-0.5">
                  <span className="text-[10px] font-poppins text-muted-foreground">Business Name:</span>
                  <span className="text-[12px] font-poppins font-bold text-foreground">{pharmacyDetail?.businessName ?? "—"}</span>
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-[10px] font-poppins text-muted-foreground">Registration Number:</span>
                  <span className="text-[12px] font-poppins font-bold text-foreground">{pharmacyDetail?.registrationNumber ?? "—"}</span>
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-[10px] font-poppins text-muted-foreground">Business Address:</span>
                  <span className="text-[12px] font-poppins font-bold text-foreground leading-snug">{pharmacyDetail?.businessAddress ?? "—"}</span>
                </div>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[10px] font-poppins text-muted-foreground">Pharmacy Website:</span>
                {pharmacyDetail?.pharmacyWebsite ? (
                  <a 
                    href={pharmacyDetail.pharmacyWebsite} 
                    target="_blank" 
                    rel="noopener noreferrer" 
                    className="text-[12px] font-poppins font-bold text-primary hover:underline"
                  >
                    {pharmacyDetail.pharmacyWebsite}
                  </a>
                ) : (
                  <span className="text-[12px] font-poppins font-bold text-foreground">—</span>
                )}
              </div>
            </div>

            {/* Operation Info */}
            <div className="bg-card rounded-[16px] shadow-[0_1px_20px_0_rgba(0,0,0,0.06)] dark:shadow-[0_1px_20px_0_rgba(0,0,0,0.3)] p-5">
              <p className="text-[15px] font-poppins font-bold text-foreground mb-4">Operation Info</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
                <div className="flex flex-col gap-2">
                  <span className="text-[10px] font-poppins text-muted-foreground">Hours:</span>
                  <HoursDisplay hours={pharmacyDetail?.hours} />
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-[10px] font-poppins text-muted-foreground">Delivery Capacity:</span>
                  <span className="text-[12px] font-poppins font-bold text-foreground">
                    {pharmacyDetail?.deliveryCapacity ? "Yes" : "No"}
                  </span>
                </div>
              </div>
            </div>

            {/* Staffing Info */}
            <div className="bg-card rounded-[16px] shadow-[0_1px_20px_0_rgba(0,0,0,0.06)] dark:shadow-[0_1px_20px_0_rgba(0,0,0,0.3)] p-5">
              <p className="text-[15px] font-poppins font-bold text-foreground mb-4">Staffing Info</p>
              <div className="flex flex-col gap-0.5">
                <span className="text-[10px] font-poppins text-muted-foreground">No of Staffs:</span>
                <span className="text-[12px] font-poppins font-bold text-foreground">{pharmacyDetail?.staffCount ?? 0}</span>
              </div>
            </div>

            {/* Tabs */}
            <div className="bg-card rounded-[16px] shadow-[0_1px_20px_0_rgba(0,0,0,0.06)] dark:shadow-[0_1px_20px_0_rgba(0,0,0,0.3)] overflow-hidden">
              <div className="flex border-b border-border overflow-x-auto">
                {TABS.map((tab) => (
                  <button 
                    key={tab.value} 
                    onClick={() => setActiveTab(tab.value)}
                    className={`relative px-5 py-4 text-[13px] font-poppins font-medium whitespace-nowrap transition-colors shrink-0 ${
                      activeTab === tab.value 
                        ? "text-primary dark:text-white" 
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {tab.label}
                    {activeTab === tab.value && (
                      <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-primary dark:bg-white rounded-t-full" />
                    )}
                  </button>
                ))}
              </div>
              <div className="p-5 sm:p-6">
                {activeTab === "documents" && (pharmacyDocumentsLoading ? <DocumentsSkeleton /> : <PharmacyDocumentsTab documents={pharmacyDocuments} />)}
                {activeTab === "otherInfo" && (pharmacyStaffLoading ? <StaffSkeleton /> : <PharmacyOtherInfoTab groups={pharmacyStaff?.groups ?? []} />)}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}