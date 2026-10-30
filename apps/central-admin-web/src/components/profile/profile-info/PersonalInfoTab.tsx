"use client";

import React, { useState, useEffect } from "react";
import { useProfileStore } from "@/stores/profile.store";
import EditPersonalInfoModal from "./EditPersonalInfoModal";
import EditContactInfoModal from "./EditContactInfoModal";
import EditEducationModal from "./EditEducationModal";
import EditEmergencyContactModal from "./EditEmergencyContactModal";
import EditSocialModal from "./EditSocialModal";

const COUNTRIES = [
  { name: "Nigeria", code: "+234", iso: "NG" },
  { name: "Ghana", code: "+233", iso: "GH" },
  { name: "South Africa", code: "+27", iso: "ZA" },
  { name: "Kenya", code: "+254", iso: "KE" },
  { name: "United States", code: "+1", iso: "US" },
  { name: "United Kingdom", code: "+44", iso: "GB" },
  { name: "Canada", code: "+1", iso: "CA" },
  { name: "France", code: "+33", iso: "FR" },
  { name: "Germany", code: "+49", iso: "DE" },
  { name: "India", code: "+91", iso: "IN" },
  { name: "China", code: "+86", iso: "CN" },
  { name: "Brazil", code: "+55", iso: "BR" },
  { name: "Australia", code: "+61", iso: "AU" },
  { name: "Egypt", code: "+20", iso: "EG" },
  { name: "Ethiopia", code: "+251", iso: "ET" },
  { name: "Tanzania", code: "+255", iso: "TZ" },
  { name: "Uganda", code: "+256", iso: "UG" },
  { name: "Senegal", code: "+221", iso: "SN" },
  { name: "Cameroon", code: "+237", iso: "CM" },
  { name: "Ivory Coast", code: "+225", iso: "CI" },
  { name: "Rwanda", code: "+250", iso: "RW" },
  { name: "Zambia", code: "+260", iso: "ZM" },
  { name: "Zimbabwe", code: "+263", iso: "ZW" },
  { name: "Morocco", code: "+212", iso: "MA" },
];

const EditIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
    <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
  </svg>
);

function SkeletonLine({ w = "w-24", h = "h-3" }: { w?: string; h?: string }) {
  return <div className={`${w} ${h} bg-muted rounded animate-pulse`} />;
}

function FieldSkeleton() {
  return (
    <div className="flex flex-col gap-1">
      <SkeletonLine w="w-16" h="h-2" />
      <SkeletonLine w="w-24" h="h-3" />
    </div>
  );
}

function SectionCard({
  title,
  children,
  onEdit,
}: {
  title: string;
  children: React.ReactNode;
  onEdit?: () => void;
}) {
  return (
    <div className="bg-card border border-border rounded-[12px] p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[14px] font-poppins font-semibold text-foreground">
          {title}
        </span>
        {onEdit && (
          <button
            onClick={onEdit}
            className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
          >
            <EditIcon />
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

function FieldItem({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <span className="text-[11px] font-poppins text-muted-foreground leading-tight truncate">
        {label}
      </span>
      <span className="text-[12px] font-poppins font-semibold text-foreground leading-tight break-words">
        {value || "—"}
      </span>
    </div>
  );
}

function formatPhone(code: string, number: string) {
  if (!number) return null;
  return `${code} ${number}`.trim() || null;
}
// helper at the top of the file
function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}



function cleanPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const country = COUNTRIES.find((c) => trimmed.startsWith(c.code));
  if (!country) return trimmed;
  let number = trimmed.slice(country.code.length).trim();
  const inner = COUNTRIES.find((c) => number.startsWith(c.code));
  if (inner) number = number.slice(inner.code.length).trim();
  number = number.replace(/^[-\s]+/, "");
  return `${country.code} ${number}`;
}

export default function PersonalInfoTab() {
  const {
    profile,
    isLoading,
    fetchProfile,
    updatePersonalInfo,
    updateContactInfo,
    updateEmergencyContact,
    updateSocialLinks,
    updateEducation,
  } = useProfileStore();

  useEffect(() => {
    if (!profile) fetchProfile();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [editPersonalOpen, setEditPersonalOpen] = useState(false);
  const [editContactOpen, setEditContactOpen]   = useState(false);
  const [editEducationOpen, setEditEducationOpen] = useState(false);
  const [editEmergencyOpen, setEditEmergencyOpen] = useState(false);
  const [editSocialOpen, setEditSocialOpen]     = useState(false);




  if (isLoading || !profile) {
    return (
      <div className="flex flex-col gap-3 flex-1 min-w-0 overflow-hidden">
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
          {[0, 1].map((i) => (
            <div key={i} className="bg-card border border-border rounded-[12px] p-4">
              <SkeletonLine w="w-28" h="h-4" />
              <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 gap-3">
                {[...Array(6)].map((_, j) => <FieldSkeleton key={j} />)}
              </div>
            </div>
          ))}
        </div>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="bg-card border border-border rounded-[12px] p-4">
            <SkeletonLine w="w-36" h="h-4" />
            <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 gap-3">
              {[...Array(3)].map((_, j) => <FieldSkeleton key={j} />)}
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <>
      {/* ── Modals ── */}
      <EditPersonalInfoModal
        open={editPersonalOpen}
        onClose={() => setEditPersonalOpen(false)}
      />
      <EditContactInfoModal
        open={editContactOpen}
        onClose={() => setEditContactOpen(false)}
      />
      <EditEducationModal
        open={editEducationOpen}
        onClose={() => setEditEducationOpen(false)}
       
      />
      <EditEmergencyContactModal
        open={editEmergencyOpen}
        onClose={() => setEditEmergencyOpen(false)}
       
      />
      <EditSocialModal
        open={editSocialOpen}
        onClose={() => setEditSocialOpen(false)}
      />

      {/* ── Layout ── */}
      <div className="flex flex-col gap-3 flex-1 min-w-0 overflow-hidden">

        {/* Row 1: Personal Info + Contact Info */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">

          <SectionCard title="Personal Info" onEdit={() => setEditPersonalOpen(true)}>
            <div className="flex flex-col gap-3">
              {/* ✅ 1-col on mobile, 2-col on sm, 3-col on xl */}
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
                <FieldItem label="First Name:"     value={profile.name?.split(" ")[0]} />
                <FieldItem label="Surname Name:"   value={profile.name?.split(" ").slice(1).join(" ")} />
                <FieldItem label="Preferred Name:" value={profile.preferredName} />
              </div>
              {/* ✅ 1-col on mobile, 2-col on sm+ */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
       
<FieldItem label="Birthday:" value={formatDate(profile.birthday)} />
                <FieldItem label="Nationality:" value={profile.nationality} />
              </div>
              {/* ✅ 1-col on mobile, 2-col on sm+ */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <FieldItem label="Gender:"         value={profile.gender} />
                <FieldItem label="Marital Status:" value={profile.maritalStatus} />
              </div>
            </div>
          </SectionCard>

          <SectionCard title="Contact Info" onEdit={() => setEditContactOpen(true)}>
            <div className="flex flex-col gap-3">
              {/* ✅ 1-col on mobile, 3-col on sm+ */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <FieldItem label="Work Phone:"     value={cleanPhone(profile.workPhone)} />
<FieldItem label="Home Phone:"     value={cleanPhone(profile.homePhone)} />
<FieldItem label="Personal Phone:" value={cleanPhone(profile.personalPhone)} />
                <FieldItem label="Fax:"         value={profile.fax} />
              </div>
              <FieldItem label="Work Email Address:" value={profile.email} />
          
              {/* ✅ 1-col on mobile, 3-col on sm+ */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <FieldItem label="Address:" value={profile.address} />
                <FieldItem label="State:"   value={profile.state} />
                <FieldItem label="Country:" value={profile.country} />
              </div>
            </div>
          </SectionCard>
        </div>

        {/* Education & Certifications */}
        <SectionCard title="Education & Certifications" onEdit={() => setEditEducationOpen(true)}>
          {profile.educations.length === 0 ? (
            <p className="text-[12px] font-poppins text-muted-foreground">
              No education records added yet.
            </p>
          ) : (
            <div className="flex flex-col divide-y divide-border">
              {profile.educations.map((edu) => (
                <div key={edu.id} className="py-2.5 first:pt-0 last:pb-0">
                  <p className="text-[13px] font-poppins font-semibold text-foreground leading-snug">
                    {edu.degreeTitle || "—"}
                  </p>
                  <p className="text-[12px] font-poppins text-muted-foreground leading-snug">
                    {edu.institution || "—"}
                  </p>
                  <p className="text-[12px] font-poppins text-muted-foreground leading-snug">
                    {edu.from && edu.to ? `${edu.from} – ${edu.to}` : "—"}
                  </p>
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        {/* Employment Info — read-only */}
        <SectionCard title="Employment Info">
          <div className="flex flex-col gap-3">
            {/* ✅ 1-col → 2-col → 3-col → 5-col progression */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5 gap-3">
              <FieldItem label="Position:"            value={profile.position} />
              <FieldItem label="Department:"          value={profile.department} />
              <FieldItem label="Employment Type:"     value={profile.employmentType} />
              <FieldItem label="Employment Category:" value={profile.employmentCategory} />
              <FieldItem
                label="Employment Date:"
                value={
                  profile.createdAt
                    ? new Date(profile.createdAt).toLocaleDateString("en-GB", {
                        day: "numeric",
                        month: "long",
                        year: "numeric",
                      })
                    : null
                }
              />
            </div>
            <FieldItem label="Location:" value={profile.location} />
          </div>
        </SectionCard>

        {/* Emergency Contact */}
        <SectionCard title="Emergency Contact" onEdit={() => setEditEmergencyOpen(true)}>
          {/* ✅ 1-col → 2-col → 4-col */}
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
            <FieldItem label="Next of Kin:"   value={profile.emergencyName} />
            <FieldItem label="Phone Number:"  value={profile.emergencyPhone} />
            <FieldItem label="Email Address:" value={profile.emergencyEmail} />
            <FieldItem label="Relationship:"  value={profile.emergencyRelation} />
          </div>
        </SectionCard>

        {/* Social */}
        <SectionCard title="Social" onEdit={() => setEditSocialOpen(true)}>
          {profile.socialLinks.length === 0 ? (
            <p className="text-[12px] font-poppins text-muted-foreground">
              No social links added yet.
            </p>
          ) : (
            // ✅ 1-col → 2-col → 3-col → 5-col
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5 gap-3">
              {profile.socialLinks.map((s) => (
                <FieldItem key={s.id} label={`${s.platform}:`} value={s.username} />
              ))}
            </div>
          )}
        </SectionCard>

      </div>
    </>
  );
}