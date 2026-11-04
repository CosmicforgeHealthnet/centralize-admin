"use client";

import { useSyncExternalStore } from "react";
import { SECTION_LABELS } from "./marketing-navigation";
import MarketingSubNav from "./MarketingSubNav";
import MarketingOverviewPage from "./overview/MarketingOverviewPage";
import CampaignsPage from "./campaigns/CampaignsPage";
import ContentManagerPage from "./content-manager/ContentManagerPage";
import EmailTemplatePage from "./email-template/EmailTemplatePage";
import SocialMediaPage from "./social-media/SocialMediaPage";
import SocialOperationsPage from "./social-operations/SocialOperationsPage";
import BannersPromotionPage from "./banners-promotion/BannersPromotionPage";
import PerformanceDashboardPage from "./performance-dashboard/PerformanceDashboardPage";
import AIMarketingIntelligencePage from "./ai-marketing-intelligence/AIMarketingIntelligencePage";
import MarketingIntelligencePage from "./marketing-intelligence/MarketingIntelligencePage";
import AdvertisingExecutionPage from "./advertising-execution/AdvertisingExecutionPage";



function subscribeSection(callback: () => void) {
  window.addEventListener("popstate", callback);
  return () => window.removeEventListener("popstate", callback);
}
function readSection() {
  const section = new URLSearchParams(window.location.search).get("section");
  return section && SECTION_LABELS[section] ? section : "overview";
}
const serverSection = () => "overview";

export default function MarketingPage() {
  const activeSection = useSyncExternalStore(subscribeSection, readSection, serverSection);
  const navigate = (section: string) => {
    const url = new URL(window.location.href);
    if (section === "overview") url.searchParams.delete("section"); else url.searchParams.set("section", section);
    window.history.pushState(null, "", url);
    window.dispatchEvent(new PopStateEvent("popstate"));
  };

  const renderSection = () => {
    switch (activeSection) {
      case "overview":                  return <MarketingOverviewPage onNavigate={navigate} />;
      case "campaigns":                 return <CampaignsPage />;
      case "content-manager":           return <ContentManagerPage />;
      case "email-template":            return <EmailTemplatePage />;
      case "social-media":              return <SocialMediaPage />;
      case "social-operations":         return <SocialOperationsPage />;
      case "banners-promotion":         return <BannersPromotionPage />;
      case "performance-dashboard":     return <PerformanceDashboardPage />;
      case "ai-marketing-intelligence": return <AIMarketingIntelligencePage />;
      case "marketing-intelligence": return <MarketingIntelligencePage />;
      case "advertising-execution":     return <AdvertisingExecutionPage />;
      default:
        return (
          <div className="flex items-center justify-center h-64">
            <p className="font-poppins text-[13px] text-muted-foreground">Coming soon</p>
          </div>
        );
    }
  };

  return (
    <div className="min-w-0 space-y-5">
      <header><p className="mb-1 text-xs font-medium text-muted-foreground">Marketing</p><h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">{SECTION_LABELS[activeSection]}</h1></header>
      <div className="flex min-w-0 flex-col gap-5 min-[1200px]:flex-row min-[1200px]:items-start">
        <MarketingSubNav activeSection={activeSection} onSectionChange={navigate} />
        <div className="min-w-0 flex-1">{renderSection()}</div>
      </div>
    </div>
  );
}
