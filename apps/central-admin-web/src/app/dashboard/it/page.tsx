"use client";

import { useState } from "react";
import ITSubNav, { type ITSection } from "@/components/it/ITSubNav";
import ITStatCards from "@/components/it/ITStatCards";
import ConsultationTable from "@/components/it/ConsultationTable";
import RTCSessionTable from "@/components/it/RTCSessionTable";
import DeliveryTable from "@/components/it/DeliveryTable";
import TransactionsTable from "@/components/it/TransactionsTable";
import AuditLogTable from "@/components/it/AuditLogTable";
import NotificationsTable from "@/components/it/NotificationsTable";
import ServiceRegistryTable from "@/components/it/ServiceRegistryTable";

// Add these missing imports based on your ITSection types
import JobMonitoringTable from "@/components/it/JobMonitoringTable";
import DeadLettersTable from "@/components/it/DeadLettersTable";
import WebhooksTable from "@/components/it/WebhooksTable";
import WebhookLogsTable from "@/components/it/WebhookLogsTable";
import IncidentsTable from "@/components/it/IncidentsTable";
import AlertsTable from "@/components/it/AlertsTable";
import FeatureFlagsTable from "@/components/it/FeatureFlagsTable";
import HealthHistoryTable from "@/components/it/HealthHistoryTable";
import EnvConfigsTable from "@/components/it/EnvConfigsTable";
import MailAdministration from "@/components/it/MailAdministration";

export default function ITPage() {
  const [activeSection, setActiveSection] = useState<ITSection>("overview");

  return (
    <div className="flex gap-4">
      <div className="hidden min-[1014px]:block w-[160px] shrink-0">
        <ITSubNav active={activeSection} onChange={setActiveSection} />
      </div>

      <div className="flex-1 min-w-0 flex flex-col gap-4">
        <div className="min-[1014px]:hidden">
          <ITSubNav active={activeSection} onChange={setActiveSection} />
        </div>

        {activeSection === "overview" && (
          <>
            <div>
              <h1 className="text-title text-foreground mb-1">I.T and Systems</h1>
              <p className="text-[13px] font-poppins text-muted-foreground">
                Monitor and manage all system services in real time.
              </p>
            </div>
            <ITStatCards />
            <ConsultationTable />
            <RTCSessionTable />
          </>
        )}

        {activeSection === "telemedicine" && <ConsultationTable />}
        {activeSection === "rtc" && <RTCSessionTable />}
        {activeSection === "logistics" && <DeliveryTable />}
        {activeSection === "payments" && <TransactionsTable />}
        {activeSection === "audit" && <AuditLogTable />}
        {activeSection === "notifications" && <NotificationsTable />}
        {activeSection === "services" && <ServiceRegistryTable />}
        {activeSection === "jobs" && <JobMonitoringTable />}
        {activeSection === "dead-letters" && <DeadLettersTable />}
        {activeSection === "webhooks" && <WebhooksTable />}
        {activeSection === "webhook-logs" && <WebhookLogsTable />}
        {activeSection === "incidents" && <IncidentsTable />}
        {activeSection === "alerts" && <AlertsTable />}
        {activeSection === "flags" && <FeatureFlagsTable />}
        {activeSection === "health" && <HealthHistoryTable />}
        {activeSection === "env-configs" && <EnvConfigsTable />}
        {activeSection === "mail-admin" && <MailAdministration />}
      </div>
    </div>
  );
}