"use client";

import { useState } from "react";
import AdvertisingExecutionSubNav, { AESection } from "./AdvertisingExecutionSubNav";
import OverviewPage from "./OverviewPage";
import PlansListPage from "./PlansListPage";
import CreatePlanContextPage from "./CreatePlanContextPage";
import PlanBuilderPage from "./PlanBuilderPage";
import PlanDetailPage from "./PlanDetailPage";
import ValidationWorkspacePage from "./ValidationWorkspacePage";
import ApprovalCentrePage from "./ApprovalCentrePage";
import ApprovalPacketDetailPage from "./ApprovalPacketDetailPage";
import ExecutionRunsPage from "./ExecutionRunsPage";
import RunDetailPage from "./RunDetailPage";
import OperationDetailPage from "./OperationDetailPage";
import DriftIncidentListPage from "./DriftIncidentListPage";
import IncidentDetailPage from "./IncidentDetailPage";
import CompensationPlanPage from "./CompensationPlanPage";
import CreativePublicationsListPage from "./CreativePublicationsListPage";
import PolicyAdministrationPage from "./PolicyAdministrationPage";
import EmergencyOverridePage from "./EmergencyOverridePage";
import ProviderReadinessPage from "./ProviderReadinessPage";
import SystemHealthPage from "./SystemHealthPage";

export default function AdvertisingExecutionPage() {
  const [activeSection, setActiveSection] = useState<AESection>("overview");

  // Drill-down state — mirrors the AMI container's selected-id pattern.
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [creatingPlan, setCreatingPlan] = useState(false);
  const [buildingPlanId, setBuildingPlanId] = useState<string | null>(null);
  const [validatingPlanId, setValidatingPlanId] = useState<string | null>(null);
  const [selectedApprovalPlanId, setSelectedApprovalPlanId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedOperationId, setSelectedOperationId] = useState<string | null>(null);
  const [selectedIncidentId, setSelectedIncidentId] = useState<string | null>(null);
  const [compensatingIncidentId, setCompensatingIncidentId] = useState<string | null>(null);
  const [showOverride, setShowOverride] = useState(false);

  const navigate = (section: AESection) => {
    setSelectedPlanId(null);
    setCreatingPlan(false);
    setBuildingPlanId(null);
    setValidatingPlanId(null);
    setSelectedApprovalPlanId(null);
    setSelectedRunId(null);
    setSelectedOperationId(null);
    setSelectedIncidentId(null);
    setCompensatingIncidentId(null);
    setShowOverride(false);
    setActiveSection(section);
  };

  const renderSection = () => {
    switch (activeSection) {
      case "overview":
        return <OverviewPage onNavigate={navigate} />;

      case "plans":
        if (creatingPlan) {
          return (
            <CreatePlanContextPage
              onCreated={(planId) => {
                setCreatingPlan(false);
                setBuildingPlanId(planId);
              }}
              onCancel={() => setCreatingPlan(false)}
            />
          );
        }
        if (buildingPlanId) {
          return (
            <PlanBuilderPage
              id={buildingPlanId}
              onDone={() => {
                setBuildingPlanId(null);
                setSelectedPlanId(buildingPlanId);
              }}
              onBack={() => setBuildingPlanId(null)}
            />
          );
        }
        if (validatingPlanId) {
          return (
            <ValidationWorkspacePage
              id={validatingPlanId}
              onSubmitted={() => {
                setValidatingPlanId(null);
                setSelectedPlanId(validatingPlanId);
              }}
              onBack={() => {
                setValidatingPlanId(null);
                setSelectedPlanId(validatingPlanId);
              }}
            />
          );
        }
        if (selectedPlanId) {
          return (
            <PlanDetailPage
              id={selectedPlanId}
              onBack={() => setSelectedPlanId(null)}
              onEdit={() => setBuildingPlanId(selectedPlanId)}
              onValidate={() => setValidatingPlanId(selectedPlanId)}
            />
          );
        }
        return (
          <PlansListPage
            onOpenPlan={setSelectedPlanId}
            onCreatePlan={() => setCreatingPlan(true)}
          />
        );

      case "approvals":
        return selectedApprovalPlanId ? (
          <ApprovalPacketDetailPage
            planId={selectedApprovalPlanId}
            onBack={() => setSelectedApprovalPlanId(null)}
          />
        ) : (
          <ApprovalCentrePage onOpenPacket={setSelectedApprovalPlanId} />
        );

      case "execution-runs":
        if (selectedOperationId) {
          return (
            <OperationDetailPage
              id={selectedOperationId}
              onBack={() => setSelectedOperationId(null)}
            />
          );
        }
        return selectedRunId ? (
          <RunDetailPage
            id={selectedRunId}
            onBack={() => setSelectedRunId(null)}
            onOpenOperation={setSelectedOperationId}
          />
        ) : (
          <ExecutionRunsPage onOpenRun={setSelectedRunId} />
        );

      case "drift-incidents":
        if (compensatingIncidentId) {
          return (
            <CompensationPlanPage
              incidentId={compensatingIncidentId}
              onDone={(planId) => {
                setCompensatingIncidentId(null);
                setActiveSection("plans");
                setSelectedPlanId(planId);
              }}
              onBack={() => setCompensatingIncidentId(null)}
            />
          );
        }
        return selectedIncidentId ? (
          <IncidentDetailPage
            id={selectedIncidentId}
            onBack={() => setSelectedIncidentId(null)}
            onCreateCompensation={() => setCompensatingIncidentId(selectedIncidentId)}
          />
        ) : (
          <DriftIncidentListPage onOpenIncident={setSelectedIncidentId} />
        );

      case "creatives":
        return <CreativePublicationsListPage />;

      case "policies-controls":
        return showOverride ? (
          <EmergencyOverridePage onBack={() => setShowOverride(false)} />
        ) : (
          <PolicyAdministrationPage onOpenOverride={() => setShowOverride(true)} />
        );

      case "provider-readiness":
        return <ProviderReadinessPage />;

      case "health":
        return <SystemHealthPage />;

      default:
        return null;
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <AdvertisingExecutionSubNav activeSection={activeSection} onSectionChange={navigate} />
      {renderSection()}
    </div>
  );
}