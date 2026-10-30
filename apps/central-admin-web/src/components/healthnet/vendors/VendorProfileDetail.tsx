"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import { CreditCard, Phone, Mail, MapPin, Calendar, Building, Globe, Clock, Truck, Users } from "lucide-react";
import VendorDocumentsTab from "./VendorDocumentsTab";
import VendorOtherInfoTab from "./VendorOtherInfoTab";

type Tab = "documents" | "otherInfo";
const TABS: { label: string; value: Tab }[] = [
  { label: "Documents", value: "documents" },
  { label: "Other Info", value: "otherInfo" },
];

// Helper to format hours display
const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

function HoursDisplay({ hours }: { hours?: string | null }) {
  if (!hours) return <span className="text-[12px] font-poppins font-bold text-foreground">—</span>;

  let parsed: Record<string, string> | null = null;
  try {
    const val = typeof hours === "string" ? JSON.parse(hours) : hours;
    if (typeof val === "object" && val !== null) parsed = val;
  } catch {
    // plain string
  }

  if (!parsed) {
    return <span className="text-[12px] font-poppins font-bold text-foreground">{hours}</span>;
  }

  return (
    <div className="flex flex-col gap-2 w-full">
      {DAYS.map((day) => {
        const val = parsed![day];
        if (!val) return null;
        const closed = val === "closed";
        return (
          <div key={day} className="flex items-center gap-3 flex-wrap">
            <span className="text-[11px] font-poppins font-semibold text-muted-foreground capitalize w-8 shrink-0">
              {day.slice(0, 3)}
            </span>
            <span
              className={`text-[11px] font-poppins font-bold ${
                closed ? "text-destructive" : "text-foreground"
              }`}
            >
              {closed ? "Closed" : val}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// Status Badge Component
function StatusBadge({ status }: { status: string }) {
  const isPending = status === "pending" || status === "Pending";
  const isActive =
    status === "active" ||
    status === "Active" ||
    status === "approved" ||
    status === "Approved";

  return (
    <div
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-poppins font-semibold ${
        isPending
          ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
          : isActive
          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
          : "bg-destructive/10 text-destructive"
      }`}
    >
      <span
        className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
          isPending
            ? "bg-amber-500 text-white"
            : isActive
            ? "bg-emerald-500 text-white"
            : "bg-destructive text-white"
        }`}
      >
        {status.charAt(0).toUpperCase()}
      </span>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </div>
  );
}

// Info Row Component for Contact Details
function InfoRow({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ElementType;
  label: string;
  value: string | null | undefined;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="w-7 h-7 rounded-[6px] bg-secondary flex items-center justify-center shrink-0 mt-0.5">
        <Icon className="w-3.5 h-3.5 text-primary" />
      </div>
      <div className="flex flex-col gap-0.5 min-w-0 flex-1">
        <span className="text-[10px] font-poppins text-muted-foreground">{label}</span>
        <span className="text-[12px] font-poppins font-semibold text-foreground break-words">
          {value ?? "—"}
        </span>
      </div>
    </div>
  );
}

// Skeletons
function LeftPanelSkeleton() {
  return (
    <div className="w-full lg:w-[260px] xl:w-[280px] shrink-0 flex flex-col gap-4">
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
        <div
          key={i}
          className="bg-card rounded-[16px] shadow-[0_1px_20px_0_rgba(0,0,0,0.06)] dark:shadow-[0_1px_20px_0_rgba(0,0,0,0.3)] p-5"
        >
          <div className="h-4 w-36 bg-muted rounded animate-pulse mb-4" />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            {Array.from({ length: i === 0 ? 2 : 1 }).map((_, j) => (
              <div key={j} className="flex flex-col gap-1.5">
                <div className="h-2.5 w-24 bg-muted rounded animate-pulse" />
                <div className="h-3.5 w-32 bg-muted rounded animate-pulse" />
              </div>
            ))}
          </div>
        </div>
      ))}
      <div className="bg-card rounded-[16px] shadow-[0_1px_20px_0_rgba(0,0,0,0.06)] dark:shadow-[0_1px_20px_0_rgba(0,0,0,0.3)] overflow-hidden">
        <div className="flex border-b border-border px-5 gap-6 py-4 overflow-x-auto">
          <div className="h-4 w-20 bg-muted rounded animate-pulse" />
          <div className="h-4 w-20 bg-muted rounded animate-pulse" />
        </div>
        <div className="p-5">
          <div className="h-32 bg-muted rounded animate-pulse" />
        </div>
      </div>
    </div>
  );
}

// Mock vendor data - replace with your actual API/data fetching
interface VendorDetail {
  id: string;
  businessName: string;
  registrationNumber: string;
  businessAddress: string;
  pharmacyWebsite?: string;
  contactName: string;
  phone: string;
  email: string;
  location: string;
  registrationDate: string;
  status: "pending" | "active" | "approved" | "inactive";
  avatarUrl?: string | null;
  hours?: string | null;
  deliveryCapacity: boolean;
  staffCount: number;
}

const MOCK_VENDOR_DATA: Record<string, VendorDetail> = {
  "vendor-1": {
    id: "vendor-1",
    businessName: "Bellarie Pharmacy",
    registrationNumber: "Bellarie123478",
    businessAddress: "12, Jakande Estate, Ikela Lagos Nigeria.",
    pharmacyWebsite: "https://bellariepharmacy.com",
    contactName: "Dema UI/UX",
    phone: "+23481234567",
    email: "lorempisum@gmail.com",
    location: "Ikela, Lagos Nigeria",
    registrationDate: "08/06/2024",
    status: "active",
    avatarUrl: null,
    hours: JSON.stringify({
      monday: "07:00 AM - 07:00 PM",
      tuesday: "07:00 AM - 07:00 PM",
      wednesday: "07:00 AM - 07:00 PM",
      thursday: "07:00 AM - 07:00 PM",
      friday: "07:00 AM - 07:00 PM",
      saturday: "09:00 AM - 05:00 PM",
      sunday: "closed",
    }),
    deliveryCapacity: true,
    staffCount: 15,
  },
  "vendor-2": {
    id: "vendor-2",
    businessName: "Lebanon Collectibles",
    registrationNumber: "Lebanon789012",
    businessAddress: "45, Allen Avenue, Ikeja Lagos Nigeria.",
    pharmacyWebsite: "https://lebanoncollectibles.com",
    contactName: "John Doe",
    phone: "+23498765432",
    email: "contact@lebanon.com",
    location: "Ikeja, Lagos Nigeria",
    registrationDate: "15/03/2024",
    status: "pending",
    avatarUrl: null,
    hours: JSON.stringify({
      monday: "08:00 AM - 06:00 PM",
      tuesday: "08:00 AM - 06:00 PM",
      wednesday: "08:00 AM - 06:00 PM",
      thursday: "08:00 AM - 06:00 PM",
      friday: "08:00 AM - 06:00 PM",
      saturday: "10:00 AM - 02:00 PM",
      sunday: "closed",
    }),
    deliveryCapacity: false,
    staffCount: 8,
  },
};

export default function VendorProfileDetail({
  id,
  onBack,
}: {
  id: string;
  onBack: () => void;
}) {
  const [activeTab, setActiveTab] = useState<Tab>("documents");
  const [loading, setLoading] = useState(true);
  const [vendorDetail, setVendorDetail] = useState<VendorDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Simulate API fetch - replace with your actual data fetching
  useEffect(() => {
    let active = true;
    queueMicrotask(() => { if (active) setLoading(true); });
    const timer = setTimeout(() => {
      const vendor = MOCK_VENDOR_DATA[id];
      if (vendor) {
        setVendorDetail(vendor);
        setError(null);
      } else {
        setError("Vendor not found");
      }
      setLoading(false);
    }, 500);

    return () => { active = false; clearTimeout(timer); };
  }, [id]);

  if (error) {
    return (
      <div className="py-20 text-center">
        <p className="text-[13px] font-poppins text-destructive">{error}</p>
        <button
          onClick={onBack}
          className="mt-4 text-[13px] font-poppins text-primary hover:underline"
        >
          Go back
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 w-full min-w-0 overflow-hidden">
      <h1 className="text-[20px] sm:text-[24px] font-poppins font-bold text-foreground">
        Vendor Profile Details
      </h1>

      <div className="flex flex-col lg:flex-row gap-5 items-start w-full min-w-0">
        {/* ── Left Panel ── */}
        {loading ? (
          <LeftPanelSkeleton />
        ) : (
          vendorDetail && (
            <div className="w-full lg:w-[260px] xl:w-[280px] lg:shrink-0 flex flex-col gap-4 min-w-0">
              {/* Avatar / Logo */}
              <div className="bg-card rounded-[16px] shadow-[0_1px_20px_0_rgba(0,0,0,0.06)] dark:shadow-[0_1px_20px_0_rgba(0,0,0,0.3)] overflow-hidden">
                <div className="w-full aspect-[4/3] bg-gradient-to-br from-primary/10 to-secondary/30 relative">
                  {vendorDetail.avatarUrl ? (
                    <Image
                      src={vendorDetail.avatarUrl}
                      alt={vendorDetail.businessName}
                      fill
                      className="object-cover"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = "none";
                      }}
                    />
                  ) : (
                    <div className="w-full h-full flex flex-col items-center justify-center gap-2">
                      <Building className="w-16 h-16 text-muted-foreground/40" />
                      <span className="text-[48px] font-poppins font-bold text-muted-foreground/30">
                        {vendorDetail.businessName?.charAt(0) ?? "V"}
                      </span>
                    </div>
                  )}
                </div>
              </div>

              {/* Contact Details */}
              <div className="bg-card rounded-[16px] shadow-[0_1px_20px_0_rgba(0,0,0,0.06)] dark:shadow-[0_1px_20px_0_rgba(0,0,0,0.3)] p-4 flex flex-col gap-3">
                <p className="text-[13px] font-poppins font-bold text-foreground">
                  Contact Details
                </p>
                <InfoRow icon={Users} label="Full Name:" value={vendorDetail.contactName} />
                <InfoRow icon={Phone} label="Phone Number:" value={vendorDetail.phone} />
                <InfoRow icon={Mail} label="Email Address:" value={vendorDetail.email} />
                <InfoRow icon={MapPin} label="Location:" value={vendorDetail.location} />
                <InfoRow
                  icon={Calendar}
                  label="Registration Date:"
                  value={vendorDetail.registrationDate}
                />
              </div>

              {/* Status */}
              <div className="bg-card rounded-[16px] shadow-[0_1px_20px_0_rgba(0,0,0,0.06)] dark:shadow-[0_1px_20px_0_rgba(0,0,0,0.3)] p-4 flex flex-col gap-2">
                <p className="text-[13px] font-poppins font-bold text-foreground">Status</p>
                <StatusBadge status={vendorDetail.status} />
              </div>
            </div>
          )
        )}

        {/* ── Right Panel ── */}
        {loading ? (
          <RightPanelSkeleton />
        ) : (
          vendorDetail && (
            <div className="flex-1 min-w-0 w-full overflow-hidden flex flex-col gap-5">
              {/* Business Information */}
              <div className="bg-card rounded-[16px] shadow-[0_1px_20px_0_rgba(0,0,0,0.06)] dark:shadow-[0_1px_20px_0_rgba(0,0,0,0.3)] p-4 sm:p-5">
                <p className="text-[15px] font-poppins font-bold text-foreground mb-4 flex items-center gap-2">
                  <Building className="w-4 h-4 text-primary" />
                  Business Information
                </p>
                {/* Max 2 cols — reacts to available container width, not viewport */}
                <div className="grid grid-cols-1 min-[780px]:grid-cols-2 gap-x-6 gap-y-4">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[10px] font-poppins text-muted-foreground">
                      Business Name:
                    </span>
                    <span className="text-[12px] sm:text-[13px] font-poppins font-bold text-foreground break-words">
                      {vendorDetail.businessName ?? "—"}
                    </span>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[10px] font-poppins text-muted-foreground">
                      Registration Number:
                    </span>
                    <span className="text-[12px] sm:text-[13px] font-poppins font-bold text-foreground break-words">
                      {vendorDetail.registrationNumber ?? "—"}
                    </span>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[10px] font-poppins text-muted-foreground">
                      Business Address:
                    </span>
                    <span className="text-[12px] sm:text-[13px] font-poppins font-bold text-foreground leading-snug break-words">
                      {vendorDetail.businessAddress ?? "—"}
                    </span>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[10px] font-poppins text-muted-foreground">
                      Vendor Website:
                    </span>
                    {vendorDetail.pharmacyWebsite ? (
                      <a
                        href={vendorDetail.pharmacyWebsite}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[12px] sm:text-[13px] font-poppins font-bold text-primary hover:underline flex items-center gap-1 break-all"
                      >
                        <Globe className="w-3 h-3 shrink-0" />
                        {vendorDetail.pharmacyWebsite}
                      </a>
                    ) : (
                      <span className="text-[12px] sm:text-[13px] font-poppins font-bold text-foreground">
                        —
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* ── Operation Info ── */}
              <div className="bg-card rounded-[16px] shadow-[0_1px_20px_0_rgba(0,0,0,0.06)] dark:shadow-[0_1px_20px_0_rgba(0,0,0,0.3)] p-4 sm:p-5">
                <p className="text-[15px] font-poppins font-bold text-foreground mb-4 flex items-center gap-2">
                  <Clock className="w-4 h-4 text-primary" />
                  Operation Info
                </p>

                {/* Hours — full width */}
                <div className="flex flex-col gap-2 mb-5">
                  <span className="text-[10px] font-poppins text-muted-foreground">Hours:</span>
                  <HoursDisplay hours={vendorDetail.hours} />
                </div>

                {/* Delivery Capacity */}
                <div className="flex flex-col gap-0.5">
                  <span className="text-[10px] font-poppins text-muted-foreground flex items-center gap-1">
                    <Truck className="w-3 h-3" />
                    Delivery Capacity:
                  </span>
                  <span className="text-[12px] sm:text-[13px] font-poppins font-bold">
                    {vendorDetail.deliveryCapacity ? (
                      <span className="text-emerald-600 dark:text-emerald-400">Yes</span>
                    ) : (
                      <span className="text-destructive">No</span>
                    )}
                  </span>
                </div>
              </div>

              {/* Staffing Info */}
              <div className="bg-card rounded-[16px] shadow-[0_1px_20px_0_rgba(0,0,0,0.06)] dark:shadow-[0_1px_20px_0_rgba(0,0,0,0.3)] p-4 sm:p-5">
                <p className="text-[15px] font-poppins font-bold text-foreground mb-4 flex items-center gap-2">
                  <Users className="w-4 h-4 text-primary" />
                  Staffing Info
                </p>
                <div className="flex flex-col gap-0.5">
                  <span className="text-[10px] font-poppins text-muted-foreground">
                    Number of Staff:
                  </span>
                  <span className="text-[12px] sm:text-[13px] font-poppins font-bold text-foreground">
                    {vendorDetail.staffCount ?? 0}
                  </span>
                </div>
              </div>

              {/* Tabs Section */}
              <div className="bg-card rounded-[16px] shadow-[0_1px_20px_0_rgba(0,0,0,0.06)] dark:shadow-[0_1px_20px_0_rgba(0,0,0,0.3)] overflow-hidden">
                {/* Tab Headers */}
                <div className="flex border-b border-border overflow-x-auto scrollbar-hide">
                  {TABS.map((tab) => (
                    <button
                      key={tab.value}
                      onClick={() => setActiveTab(tab.value)}
                      className={`relative px-4 sm:px-5 py-3 sm:py-4 text-[12px] sm:text-[13px] font-poppins font-medium whitespace-nowrap transition-all duration-200 shrink-0 ${
                        activeTab === tab.value
                          ? "text-primary dark:text-white"
                          : "text-muted-foreground hover:text-foreground hover:bg-muted/30"
                      }`}
                    >
                      {tab.label}
                      {activeTab === tab.value && (
                        <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-primary dark:bg-white rounded-t-full" />
                      )}
                    </button>
                  ))}
                </div>

                {/* Tab Content */}
                <div className="p-4 sm:p-5 md:p-6">
                  {activeTab === "documents" && <VendorDocumentsTab />}
                  {activeTab === "otherInfo" && <VendorOtherInfoTab />}
                </div>
              </div>
            </div>
          )
        )}
      </div>
    </div>
  );
}