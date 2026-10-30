"use client";

import { useState } from "react";
import SocialOperationsSubNav, { SOSection } from "./SocialOperationsSubNav";
import SocialOperationsOverviewPage from "./overview/SocialOperationsOverviewPage";
import SocialConnectionsPage from "./accounts/SocialConnectionsPage";
import PostComposerPage from "./content/PostComposerPage";
import MediaLibraryPage from "./content/MediaLibraryPage";
import ApprovalQueuePage from "./content/ApprovalQueuePage";
import ContentCalendarPage from "./content/ContentCalendarPage";
import ProviderContentPage from "./content/ProviderContentPage";
import UnifiedInboxPage from "./inbox/UnifiedInboxPage";
import CommentsQueuePage from "./inbox/CommentsQueuePage";
import EscalationQueuePage from "./inbox/EscalationQueuePage";
import OrganicAnalyticsPage from "./analytics/OrganicAnalyticsPage";
import OperationsMonitorPage from "./operations/OperationsMonitorPage";
import SocialOperationsSettingsPage from "./settings/SocialOperationsSettingsPage";

const CONTENT_TABS = [
  { key: "composer", label: "Composer" },
  { key: "calendar", label: "Calendar" },
  { key: "approvals", label: "Approvals" },
  { key: "media", label: "Media Library" },
  { key: "provider", label: "Provider Content" },
] as const;

const INBOX_TABS = [
  { key: "conversations", label: "Conversations" },
  { key: "comments", label: "Comments" },
  { key: "escalations", label: "Escalations" },
] as const;

export default function SocialOperationsPage() {
  const [activeSection, setActiveSection] = useState<SOSection>("overview");
  const [contentTab, setContentTab] = useState<(typeof CONTENT_TABS)[number]["key"]>("calendar");
  const [inboxTab, setInboxTab] = useState<(typeof INBOX_TABS)[number]["key"]>("conversations");

  const renderContent = () => {
    switch (contentTab) {
      case "composer": return <PostComposerPage />;
      case "calendar": return <ContentCalendarPage />;
      case "approvals": return <ApprovalQueuePage />;
      case "media": return <MediaLibraryPage />;
      case "provider": return <ProviderContentPage />;
    }
  };

  const renderInbox = () => {
    switch (inboxTab) {
      case "conversations": return <UnifiedInboxPage />;
      case "comments": return <CommentsQueuePage />;
      case "escalations": return <EscalationQueuePage />;
    }
  };

  const renderSection = () => {
    switch (activeSection) {
      case "overview": return <SocialOperationsOverviewPage onNavigate={(s) => setActiveSection(s as SOSection)} />;
      case "accounts": return <SocialConnectionsPage />;
      case "content": return (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-1 flex-wrap">
            {CONTENT_TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setContentTab(t.key)}
                className={`font-poppins text-[11px] font-medium px-3 py-1.5 rounded-full transition-colors ${
                  contentTab === t.key ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          {renderContent()}
        </div>
      );
      case "inbox": return (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-1 flex-wrap">
            {INBOX_TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setInboxTab(t.key)}
                className={`font-poppins text-[11px] font-medium px-3 py-1.5 rounded-full transition-colors ${
                  inboxTab === t.key ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          {renderInbox()}
        </div>
      );
      case "analytics": return <OrganicAnalyticsPage />;
      case "operations": return <OperationsMonitorPage />;
      case "settings": return <SocialOperationsSettingsPage />;
      default: return null;
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <SocialOperationsSubNav activeSection={activeSection} onSectionChange={setActiveSection} />
      {renderSection()}
    </div>
  );
}