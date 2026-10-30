"use client";

import Image from "next/image";
import type { PharmacyStaffGroup } from "@/types/healthnet.types";

interface Props {
  groups: PharmacyStaffGroup[];
}

function StaffCard({ name, experience, phone, avatarUrl }: {
  name: string | null;
  experience: string | null;
  phone: string | null;
  avatarUrl?: string | null;
}) {
  const displayName = name ?? "—";
  return (
    <div className="flex items-center gap-2.5 p-2.5 bg-card rounded-[10px] border border-border shadow-[0_1px_6px_0_rgba(0,0,0,0.04)] dark:shadow-[0_1px_6px_0_rgba(0,0,0,0.2)] hover:shadow-[0_2px_10px_0_rgba(39,46,167,0.08)] hover:border-primary/20 transition-all duration-150">
      <div className="w-9 h-9 rounded-full overflow-hidden bg-secondary shrink-0 flex items-center justify-center">
        {avatarUrl ? (
          <Image 
            src={avatarUrl} 
            alt={displayName} 
            width={36} 
            height={36} 
            className="w-full h-full object-cover"
            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} 
          />
        ) : (
          <span className="text-[11px] font-poppins font-bold text-primary">{displayName.charAt(0)}</span>
        )}
      </div>
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="text-[11px] font-poppins font-semibold text-foreground truncate">{displayName}</span>
        {experience && <span className="text-[10px] font-poppins text-muted-foreground truncate">{experience}</span>}
        {phone && <span className="text-[10px] font-poppins text-muted-foreground truncate">{phone}</span>}
      </div>
    </div>
  );
}

export default function PharmacyOtherInfoTab({ groups }: Props) {
  if (!groups.length) {
    return (
      <p className="text-[13px] font-poppins text-muted-foreground text-center py-8">No staff available.</p>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {groups.map((group) => (
        <div key={group.role}>
          <p className="text-[12px] font-poppins font-semibold text-primary dark:text-primary mb-2.5">{group.role}:</p>
          {group.members.length === 0 ? (
            <p className="text-[11px] font-poppins text-muted-foreground pl-1">None</p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2.5">
              {group.members.map((m) => (
                <StaffCard 
                  key={m.id} 
                  name={m.name} 
                  experience={m.experience} 
                  phone={m.phone} 
                  avatarUrl={m.avatarUrl} 
                />
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}