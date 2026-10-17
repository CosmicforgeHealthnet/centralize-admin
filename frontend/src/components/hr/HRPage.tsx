"use client";

import { useState } from "react";
import HRSubNav from "./HRSubNav";
import HROverviewPage from "./overview/HROverviewPage";
import AllEmployeesPage from "./employees/AllEmployeesPage";
import DepartmentsPage from "./departments/DepartmentsPage";
import AttendancePage from "./attendance/AttendancePage";
import PayrollPage from "./payroll/PayrollPage";
import LeavesPage from "./leaves/LeavesPage";
import PerformancePage from "./performance/PerformancePage";
import HiringPage from "./hiring/HiringPage";
import DocumentsPage from "./documents/DocumentsPage";
import AccountsPage from "./accounts/AccountsPage";

export default function HRPage() {
  const [activeSection, setActiveSection] = useState("overview");

  const renderSection = () => {
    switch (activeSection) {
      case "overview":    return <HROverviewPage />;
      case "employees":   return <AllEmployeesPage />;
      case "departments": return <DepartmentsPage />;
      case "attendance":  return <AttendancePage />;
      case "payroll":     return <PayrollPage />;
      case "leaves":      return <LeavesPage />;
      case "performance": return <PerformancePage />;
      case "hiring":      return <HiringPage />;
      case "documents":   return <DocumentsPage />;
      case "accounts":    return <AccountsPage />;
      default:
        return (
          <div className="flex items-center justify-center h-64">
            <p className="font-poppins text-[13px] text-muted-foreground">Coming soon</p>
          </div>
        );
    }
  };

  const sectionLabel = () => {
    const map: Record<string, string> = {
      overview:    "Overview",
      employees:   "All Employees",
      departments: "Departments",
      attendance:  "Attendance",
      payroll:     "Payroll",
      leaves:      "Leaves",
      performance: "Performance",
      hiring:      "Hiring",
      documents:   "Documents",
      accounts:    "Accounts",
    };
    return map[activeSection] ?? activeSection;
  };

  return (
    <div className="flex flex-col gap-4 min-[1014px]:flex-row min-[1014px]:items-start">
      <HRSubNav activeSection={activeSection} onSectionChange={setActiveSection} />

      <div className="flex-1 min-w-0 bg-card border border-border rounded-[12px] overflow-hidden">
        <div className="px-4 sm:px-5 pt-4 sm:pt-5 pb-1">
          <div className="flex items-center justify-between mb-1">
            <div>
              <h1 className="text-[15px] font-poppins font-semibold text-foreground">
                Human Resources
              </h1>
              <p className="text-[12px] font-poppins text-muted-foreground mt-0.5">
                Human Resources / {sectionLabel()}
              </p>
            </div>
          </div>
          <div className="border-b border-border mt-3" />
        </div>

        <div className="p-4 sm:p-5">{renderSection()}</div>
      </div>
    </div>
  );
}