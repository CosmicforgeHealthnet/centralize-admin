"use client";

import { useState } from "react";
import PerformanceSubNav from "./PerformanceSubNav";
import PerformanceOverview from "./PerformanceOverview";

export default function PerformancePage() {
  const [activeSection, setActiveSection] = useState("overview");

  const renderSection = () => {
    switch (activeSection) {
      case "overview": return <PerformanceOverview />;
      default:
        return (
          <div className="flex items-center justify-center h-64">
            <p className="font-poppins text-[13px] text-muted-foreground capitalize">
              {activeSection} — Coming soon
            </p>
          </div>
        );
    }
  };

  return (
    <div className="flex flex-col gap-4 min-[900px]:flex-row min-[900px]:items-start">
      <div className="min-[900px]:w-[140px] min-[900px]:shrink-0">
        <PerformanceSubNav active={activeSection} onChange={setActiveSection} />
      </div>
      <div className="flex-1 min-w-0">
        {renderSection()}
      </div>
    </div>
  );
}