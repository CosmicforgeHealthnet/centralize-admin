"use client";

import { useState } from "react";
import MarketingIntelligenceSubNav, { MISection } from "./MarketingIntelligenceSubNav";
import MIPerformanceDashboardPage from "./PerformanceDashboardPage";
import MIConnectionsPage from "./ConnectionsPage";
import MISyncHealthPage from "./SyncHealthPage";

export default function MarketingIntelligencePage() {
  const [activeSection, setActiveSection] = useState<MISection>("performance-dashboard");

  const renderSection = () => {
    switch (activeSection) {
      case "performance-dashboard": return <MIPerformanceDashboardPage />;
      case "connections":           return <MIConnectionsPage />;
      case "sync-health":           return <MISyncHealthPage />;
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <MarketingIntelligenceSubNav activeSection={activeSection} onSectionChange={setActiveSection} />
      {renderSection()}
    </div>
  );
}