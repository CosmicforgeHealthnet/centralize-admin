"use client";

import { useState } from "react";
import AIMarketingIntelligenceSubNav, { AMISection } from "./AIMarketingIntelligenceSubNav";
import OverviewPage from "./OverviewPage";
import MIPerformanceDashboardPage from "@/components/marketing/marketing-intelligence/PerformanceDashboardPage";
import MIConnectionsPage from "@/components/marketing/marketing-intelligence/ConnectionsPage";
import ProviderValidationPage from "./ProviderValidationPage";
import CreativeLibraryPage from "./CreativeLibraryPage";
import CreativeDetailPage from "./CreativeDetailPage";
import RecommendationsPage from "./RecommendationsPage";
import RecommendationDetailPage from "./RecommendationDetailPage";
import AlertsPage from "./AlertsPage";
import AlertDetailPage from "./AlertDetailPage";
import ExperimentsPage from "./ExperimentsPage";
import ExperimentDetailPage from "./ExperimentDetailPage";
import EvaluationRunsPage from "./EvaluationRunsPage";
import EvaluationRunDetailPage from "./EvaluationRunDetailPage";
import SettingsControlsPage from "./SettingsControlsPage";

export default function AIMarketingIntelligencePage() {
  const [activeSection, setActiveSection] = useState<AMISection>("overview");
  const [selectedCreativeId, setSelectedCreativeId] = useState<string | null>(null);
  const [selectedRecommendationId, setSelectedRecommendationId] = useState<string | null>(null);
  const [selectedAlertId, setSelectedAlertId] = useState<string | null>(null);
  const [selectedExperimentId, setSelectedExperimentId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const navigate = (section: AMISection) => {
    setSelectedCreativeId(null);
    setSelectedRecommendationId(null);
    setSelectedAlertId(null);
    setSelectedExperimentId(null);
    setSelectedRunId(null);
    setActiveSection(section);
  };

  const renderSection = () => {
    switch (activeSection) {
      case "overview":
        return <OverviewPage onNavigate={navigate} />;

      case "performance":
        // Phase 2 doc §9 — Phase 1 performance dashboard remains the campaign/day foundation; reused as-is.
        return <MIPerformanceDashboardPage />;

      case "provider-connections":
        // Phase 2 doc §7 / §27 — same /connections routes as Phase 1 MI-02, no separate contract.
        return <MIConnectionsPage />;

      case "provider-validation":
        return <ProviderValidationPage />;

      case "creative-intelligence":
        return selectedCreativeId ? (
          <CreativeDetailPage id={selectedCreativeId} onBack={() => setSelectedCreativeId(null)} />
        ) : (
          <CreativeLibraryPage onOpenCreative={setSelectedCreativeId} />
        );

      case "recommendations":
        return selectedRecommendationId ? (
          <RecommendationDetailPage id={selectedRecommendationId} onBack={() => setSelectedRecommendationId(null)} />
        ) : (
          <RecommendationsPage onOpenRecommendation={setSelectedRecommendationId} />
        );

      case "alerts":
        return selectedAlertId ? (
          <AlertDetailPage id={selectedAlertId} onBack={() => setSelectedAlertId(null)} />
        ) : (
          <AlertsPage onOpenAlert={setSelectedAlertId} />
        );

      case "experiments":
        return selectedExperimentId ? (
          <ExperimentDetailPage id={selectedExperimentId} onBack={() => setSelectedExperimentId(null)} />
        ) : (
          <ExperimentsPage onOpenExperiment={setSelectedExperimentId} />
        );

      case "evaluation-runs":
        return selectedRunId ? (
          <EvaluationRunDetailPage id={selectedRunId} onBack={() => setSelectedRunId(null)} />
        ) : (
          <EvaluationRunsPage onOpenRun={setSelectedRunId} />
        );

      case "settings-controls":
        return <SettingsControlsPage />;

      default:
        return null;
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <AIMarketingIntelligenceSubNav activeSection={activeSection} onSectionChange={navigate} />
      {renderSection()}
    </div>
  );
}