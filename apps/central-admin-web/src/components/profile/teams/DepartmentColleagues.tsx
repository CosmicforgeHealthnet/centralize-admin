"use client";

import { useQuery } from "@tanstack/react-query";
import api from "@/lib/api";
import { departmentsService } from "@/lib/hrm.service";
import { readHttpErrorMessage } from "@/lib/error-messages";
import { ACCOUNT_ROLE_LABELS, formatEnumLabel } from "@/types/hrm.types";

// Colleagues in the signed-in employee's own department (basic work
// information). Team Leads and Managers also see each member's status.
export default function DepartmentColleagues() {
  const query = useQuery({
    queryKey: ["hr", "my-department"],
    queryFn: () => departmentsService.getMyColleagues({ limit: 100 }),
    retry: false,
  });
  const colleagues = query.data?.data ?? [];
  const department = colleagues[0]?.department;
  const showStatus = colleagues.some((c) => c.status !== undefined);

  // Department Managers also see their department's leave requests.
  const mine = useQuery({
    queryKey: ["hr", "my-grants-for-department"],
    queryFn: async () => (await api.get<{ data: { grants: { module: string; section: string }[] } }>("/api/hrm/accounts/me/grants")).data.data,
    retry: false,
  });
  const isManager = !!mine.data?.grants?.some((g) => g.module === "department" && g.section === "leaves");
  const leaves = useQuery({
    queryKey: ["hr", "my-department-leaves"],
    queryFn: () => departmentsService.getMyDepartmentLeaves({ limit: 50 }),
    enabled: isManager,
    retry: false,
  });

  return (
    <div className="flex flex-col gap-4 p-6 sm:p-8">
      <div>
        <h1 className="text-[24px] font-poppins font-bold text-foreground">My Department</h1>
        <p className="text-[13px] font-poppins text-muted-foreground mt-1">
          {department ? `Colleagues in ${formatEnumLabel(department)}.` : "Colleagues in your department."}
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr style={{ backgroundColor: "#E8EAF6" }}>
              <th className="px-4 py-3 text-[12px] font-poppins font-semibold text-foreground rounded-l-[8px]">Name</th>
              <th className="px-4 py-3 text-[12px] font-poppins font-semibold text-foreground">Job Title</th>
              <th className="px-4 py-3 text-[12px] font-poppins font-semibold text-foreground">Role</th>
              <th className={`px-4 py-3 text-[12px] font-poppins font-semibold text-foreground ${showStatus ? "" : "rounded-r-[8px]"}`}>Email</th>
              {showStatus && <th className="px-4 py-3 text-[12px] font-poppins font-semibold text-foreground rounded-r-[8px]">Status</th>}
            </tr>
          </thead>
          <tbody>
            {query.isLoading ? (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-sm text-muted-foreground">Loading colleagues...</td></tr>
            ) : query.error ? (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-sm text-muted-foreground">{readHttpErrorMessage(query.error) || "Your department directory is not available."}</td></tr>
            ) : colleagues.length === 0 ? (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-sm text-muted-foreground">No colleagues found</td></tr>
            ) : (
              colleagues.map((c) => (
                <tr key={c.id} className="border-b border-border">
                  <td className="px-4 py-3 text-[13px] font-poppins text-foreground">{c.name}</td>
                  <td className="px-4 py-3 text-[13px] font-poppins text-muted-foreground">{c.jobTitle ?? "—"}</td>
                  <td className="px-4 py-3 text-[13px] font-poppins text-muted-foreground">{ACCOUNT_ROLE_LABELS[c.role] ?? "—"}</td>
                  <td className="px-4 py-3 text-[13px] font-poppins text-muted-foreground">{c.email}</td>
                  {showStatus && <td className="px-4 py-3 text-[13px] font-poppins text-muted-foreground">{formatEnumLabel(c.status)}</td>}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {isManager && (
        <div className="flex flex-col gap-2 mt-4">
          <h2 className="text-[16px] font-poppins font-semibold text-foreground">Leave requests</h2>
          <p className="text-[12px] font-poppins text-muted-foreground">Your department only. Approvals stay with HR.</p>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr style={{ backgroundColor: "#E8EAF6" }}>
                  <th className="px-4 py-3 text-[12px] font-poppins font-semibold text-foreground rounded-l-[8px]">Name</th>
                  <th className="px-4 py-3 text-[12px] font-poppins font-semibold text-foreground">Type</th>
                  <th className="px-4 py-3 text-[12px] font-poppins font-semibold text-foreground">Dates</th>
                  <th className="px-4 py-3 text-[12px] font-poppins font-semibold text-foreground rounded-r-[8px]">Status</th>
                </tr>
              </thead>
              <tbody>
                {leaves.isLoading ? (
                  <tr><td colSpan={4} className="px-4 py-6 text-center text-sm text-muted-foreground">Loading leave requests...</td></tr>
                ) : (leaves.data?.data ?? []).length === 0 ? (
                  <tr><td colSpan={4} className="px-4 py-6 text-center text-sm text-muted-foreground">No leave requests</td></tr>
                ) : (
                  (leaves.data?.data ?? []).map((l) => (
                    <tr key={l.id} className="border-b border-border">
                      <td className="px-4 py-3 text-[13px] font-poppins text-foreground">{l.name ?? "—"}</td>
                      <td className="px-4 py-3 text-[13px] font-poppins text-muted-foreground">{formatEnumLabel(l.leaveType)}</td>
                      <td className="px-4 py-3 text-[13px] font-poppins text-muted-foreground">{l.startDate} → {l.resumptionDate}</td>
                      <td className="px-4 py-3 text-[13px] font-poppins text-muted-foreground">{formatEnumLabel(l.status)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
