"use client";

import { useState } from "react";
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

const SECTION_LABELS: Record<string, string> = {
  overview:                    "Overview",
  campaigns:                   "Campaigns",
  "content-manager":           "Content Manager",
  "email-template":            "Email Template",
  "social-media":              "Social Media",
  "social-operations":         "Social Operations",
  "banners-promotion":         "Banners & Promotion",
  "performance-dashboard":     "Performance Dashboard",
  "ai-marketing-intelligence": "AI Marketing Intelligence",
  "marketing-intelligence": "Marketing Intelligence",
  "advertising-execution": "Advertising Execution",
};

export default function MarketingPage() {
  const [activeSection, setActiveSection] = useState("overview");

  const renderSection = () => {
    switch (activeSection) {
      case "overview":                  return <MarketingOverviewPage />;
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
    <div className="flex flex-col gap-4 min-[1014px]:flex-row min-[1014px]:items-start">
      <MarketingSubNav activeSection={activeSection} onSectionChange={setActiveSection} />

      <div className="flex-1 min-w-0 bg-card border border-border rounded-[12px] overflow-hidden">
        <div className="px-4 sm:px-5 pt-4 sm:pt-5 pb-1">
          <div className="flex items-center justify-between mb-1">
            <div>
              <h1 className="text-[15px] font-poppins font-semibold text-foreground">
                Marketing
              </h1>
              <p className="text-[12px] font-poppins text-muted-foreground mt-0.5">
                Marketing / {SECTION_LABELS[activeSection] ?? activeSection}
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