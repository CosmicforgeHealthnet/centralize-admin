"use client";

import { useState } from "react";
import UsersSubNav, { type Section } from "@/components/users/UsersSubNav";
import UsersStatCards from "@/components/users/UsersStatCards";
import UserGrowthChart from "@/components/users/UserGrowthChart";
import SignUpTrendsChart from "@/components/users/SignUpTrendsChart";
import UsersTable from "@/components/users/UsersTable";
import AnalyticsStatCards from "@/components/users/AnalyticsStatCards";
import AnalyticsVisitorsTable from "@/components/users/AnalyticsVisitorsTable";
import AnalyticsWaitlistTable from "@/components/users/AnalyticsWaitlistTable";

export default function UsersPage() {
  const [activeSection, setActiveSection] = useState<Section>("overview");

  return (
    <div className="flex gap-4">
      <div className="hidden min-[1014px]:block w-[160px] shrink-0">
        <UsersSubNav active={activeSection} onChange={setActiveSection} />
      </div>

      <div className="flex-1 min-w-0 flex flex-col gap-4">
        <div className="min-[1014px]:hidden">
          <UsersSubNav active={activeSection} onChange={setActiveSection} />
        </div>

        {activeSection === "overview" && (
          <>
            <div>
              <h1 className="text-title text-foreground mb-1">User Management</h1>
              <p className="text-[13px] font-poppins text-muted-foreground">
                Monitor all users, growth trends and sign up activity.
              </p>
            </div>
            <UsersStatCards />
         <div className="grid grid-cols-1 2xl:grid-cols-2 gap-4">
              <UserGrowthChart />
              <SignUpTrendsChart />
            </div>
            <UsersTable />
          </>
        )}

        {activeSection === "growth"  && <UserGrowthChart />}
        {activeSection === "trends"  && <SignUpTrendsChart />}
        {activeSection === "list"    && <UsersTable />}

        {activeSection === "analytics" && (
          <>
            <div>
              <h1 className="text-title text-foreground mb-1">Landing Page Analytics</h1>
              <p className="text-[13px] font-poppins text-muted-foreground">
                Visitor sessions, traffic sources and conversion data from the landing page.
              </p>
            </div>
            <AnalyticsStatCards />
            <AnalyticsVisitorsTable />
          </>
        )}

        {activeSection === "waitlist" && (
          <>
            <div>
              <h1 className="text-title text-foreground mb-1">Waitlist Signups</h1>
              <p className="text-[13px] font-poppins text-muted-foreground">
                Pharmacy and lab partners who signed up from the landing page.
              </p>
            </div>
            <AnalyticsWaitlistTable />
          </>
        )}
      </div>
    </div>
  );
}