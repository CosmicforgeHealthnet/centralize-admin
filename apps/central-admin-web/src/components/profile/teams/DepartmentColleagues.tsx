"use client";

import { useQuery } from "@tanstack/react-query";
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
    </div>
  );
}
