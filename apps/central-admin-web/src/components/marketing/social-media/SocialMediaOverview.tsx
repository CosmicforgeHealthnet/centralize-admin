// src/components/marketing/social-media/SocialMediaOverview.tsx
"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import {
  Users, PieChart, TrendingUp as TrendingUpIcon, BarChart3, PlusCircle, ChevronLeft, ChevronRight,
  ChevronDown, MoreVertical, Sparkles, FileEdit, MessageSquare,
} from "lucide-react";
import EngagementChart from "./EngagementChart";
import AddSocialAccountModal from "./AddSocialAccountModal";
import AddNewPostModal from "./AddNewPostModal";
import { useMarketingStore } from "@/stores/marketing.store";
import { Skeleton } from "@/components/ui/skeleton";
import type { SocialPostListPlatform } from "@/types/marketing.types";

const PLATFORM_TABS: Array<{ key: SocialPostListPlatform; label: string }> = [
  { key: "All", label: "All" },
  { key: "Youtube", label: "Youtube" },
  { key: "Twitter", label: "Twitter" },
  { key: "Instagram", label: "Instagram" },
  { key: "Tiktok", label: "Tiktok" },
  { key: "LinkedIn", label: "LinkedIn" },
];

// Map country to flag emoji
const getCountryFlag = (country: string): string => {
  const flags: Record<string, string> = {
    "Indonesia": "🇮🇩",
    "USA": "🇺🇸",
    "United States": "🇺🇸",
    "Australia": "🇦🇺",
    "Russia": "🇷🇺",
    "China": "🇨🇳",
    "Brasil": "🇧🇷",
    "Brazil": "🇧🇷",
    "Nigeria": "🇳🇬",
    "UK": "🇬🇧",
    "United Kingdom": "🇬🇧",
    "Germany": "🇩🇪",
    "France": "🇫🇷",
    "Japan": "🇯🇵",
    "South Korea": "🇰🇷",
    "India": "🇮🇳",
    "Canada": "🇨🇦",
    "Mexico": "🇲🇽",
    "Italy": "🇮🇹",
    "Spain": "🇪🇸",
  };
  return flags[country] || "🌍";
};

// Builds the current Mon–Sun week with real calendar dates,
// used only when the backend hasn't returned a schedule yet.
const getCurrentWeekDays = (): { day: string; date: number }[] => {
  const dayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const today = new Date();
  const jsDay = today.getDay(); // 0 = Sun ... 6 = Sat
  const mondayOffset = jsDay === 0 ? -6 : 1 - jsDay;
  const monday = new Date(today);
  monday.setDate(today.getDate() + mondayOffset);

  return dayLabels.map((label, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return { day: label, date: d.getDate() };
  });
};

const getCurrentMonthLabel = (): string =>
  new Date().toLocaleString("default", { month: "long", year: "numeric" });

const formatShortDate = (d: Date): string =>
  d.toLocaleString("default", { day: "numeric", month: "short" });

const getLast30DaysLabel = (): string => {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - 30);
  return `${formatShortDate(start)} — ${formatShortDate(end)} ${end.getFullYear()}`;
};

function PlatformIcon({ platform, size = 16 }: { platform: string; size?: number }) {
  const colors: Record<string, string> = {
    Instagram: "linear-gradient(45deg,#f09433,#e6683c,#dc2743,#cc2366,#bc1888)",
    Facebook: "#1877F2",
    Twitter: "#000000",
    Tiktok: "#000000",
    LinkedIn: "#0A66C2",
    Youtube: "#FF0000",
  };
  return (
    <div
      className="rounded-md flex items-center justify-center shrink-0"
      style={{ width: size + 8, height: size + 8, background: colors[platform] ?? "#999" }}
    >
      <span className="text-white font-bold" style={{ fontSize: size * 0.55 }}>
        {platform.charAt(0)}
      </span>
    </div>
  );
}

interface Props {
  onViewDetail: (platform: string) => void;
}

export default function SocialMediaOverview({ onViewDetail }: Props) {
  const [activeTab, setActiveTab] = useState("All");
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [showAddPost, setShowAddPost] = useState(false);

  const {
    socialOverview,
    socialAccounts,
    socialPosts,
    socialSchedule,
    socialInsights,
    isLoadingSocialOverview,
    isLoadingSocialAccounts,
    isLoadingSocialPosts,
    isLoadingSocialSchedule,
    isLoadingSocialInsights,
    fetchSocialOverview,
    fetchSocialAccounts,
    fetchSocialPosts,
    setSocialPostFilters,
    fetchSocialSchedule,
    setSocialScheduleQuery,
    fetchSocialInsights,
    setSocialInsightsQuery,
    error,
    clearError,
  } = useMarketingStore();

  useEffect(() => {
    fetchSocialOverview();
    fetchSocialAccounts();
    setSocialPostFilters({ platform: "All", page: 1 });
    fetchSocialPosts();
    setSocialScheduleQuery({});
    fetchSocialSchedule();
    setSocialInsightsQuery({});
    fetchSocialInsights();
  }, []);

  useEffect(() => {
    if (error) {
      const timer = setTimeout(() => clearError(), 5000);
      return () => clearTimeout(timer);
    }
  }, [error, clearError]);

  const handleTabChange = (tab: SocialPostListPlatform) => {
    setActiveTab(tab);
    const platformValue = tab === "All" ? "All" : tab;
    setSocialPostFilters({ platform: platformValue, page: 1 });
    fetchSocialPosts();
  };

  const isLoading = isLoadingSocialOverview || isLoadingSocialAccounts || 
    isLoadingSocialPosts || isLoadingSocialSchedule || isLoadingSocialInsights;

  if (isLoading && !socialOverview) {
    return (
      <div className="flex flex-col gap-5">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <Skeleton className="h-6 w-32" />
            <Skeleton className="h-4 w-48 mt-1" />
          </div>
          <div className="flex items-center gap-3">
            <Skeleton className="w-9 h-9 rounded-full" />
            <Skeleton className="w-9 h-9 rounded-full" />
            <Skeleton className="w-9 h-9 rounded-full" />
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[100px] rounded-xl" />
          ))}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Skeleton className="h-[80px] rounded-xl" />
          <Skeleton className="h-[80px] rounded-xl" />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-[1.4fr_1fr] gap-4">
          <Skeleton className="h-[300px] rounded-xl" />
          <Skeleton className="h-[300px] rounded-xl" />
        </div>
        <Skeleton className="h-[300px] rounded-xl" />
      </div>
    );
  }

  // No more mock fallback numbers here — if the backend hasn't returned
  // stats yet, show real zeros rather than fabricated demo values.
  const stats = socialOverview?.stats || {
    userEngagement: 0,
    trafficSources: 0,
    audienceGrowth: 0,
    contentPerformance: 0,
  };

  // Handle locations - check if they have flag property or not
  const rawLocations = socialOverview?.locations || [];
  const locations = rawLocations.map((loc) => ({
    country: loc.country || "Unknown",
    flag: getCountryFlag(loc.country || ""),
    value: loc.value || 0,
    change: loc.change || "0%",
    up: loc.up ?? true,
  }));

  // No more hardcoded Facebook/Twitter/Instagram demo numbers —
  // empty array is handled explicitly in the render below.
  const audienceBreakdown = socialOverview?.audience?.breakdown || [];

  // No more lorem-ipsum placeholder post — null is handled explicitly below.
  const recentUpload = socialOverview?.recentUpload || null;

  const totalAudience = socialOverview?.audience?.total ?? 0;
  const audienceChange = socialOverview?.audience?.change;

  const scheduleData = socialSchedule;
  // Falls back to the real current week (correct dates) instead of a
  // fixed "Nov 15–21" range that was always wrong outside that one week.
  const scheduleDays = scheduleData?.days || getCurrentWeekDays();
  const scheduleSlots = scheduleData?.slots || [];

  const insights = socialInsights.length > 0 ? socialInsights : [];

  // Real "today" for highlighting in the schedule strip, replacing the
  // hardcoded `date === 19` check.
  const todayDate = new Date().getDate();

  return (
    <div className="flex flex-col gap-5">
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
          {error}
        </div>
      )}

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="font-poppins text-[16px] font-semibold text-foreground">Overview</h2>
          <p className="font-poppins text-[12px] text-muted-foreground mt-0.5">
            Let&apos;s see an overview of your social media
          </p>
        </div>
        <div className="flex items-center gap-3">
          {socialAccounts.slice(0, 2).map((acc) => (
            <button key={acc.id} className="w-9 h-9 rounded-full flex items-center justify-center text-white text-[13px] font-bold relative" style={{ background: acc.platform === "Instagram" ? "linear-gradient(45deg,#f09433,#dc2743,#bc1888)" : "#1877F2" }}>
              {acc.platform.charAt(0)}
              <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-green-500 border-2 border-white" />
            </button>
          ))}
          <button
            onClick={() => setShowAddAccount(true)}
            className="flex flex-col items-center gap-0.5 text-primary"
          >
            <div className="w-9 h-9 rounded-full border-2 border-primary flex items-center justify-center">
              <PlusCircle className="w-4 h-4" />
            </div>
            <span className="font-poppins text-[9px] font-semibold whitespace-nowrap">Link New Account</span>
          </button>
        </div>
      </div>

      {/*
        NOTE: change / sub / up below are still hardcoded per-card.
        The backend's SocialOverview.stats type only returns raw numbers
        (userEngagement, trafficSources, audienceGrowth, contentPerformance) —
        there's no per-metric trend/"today" field to read yet. `value` is
        real; `change`/`sub`/`up` need a backend addition before they can
        be wired to real data. Left as TODO rather than silently fabricated
        further, so it's visible in a diff/review.
      */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { icon: Users, label: "User Engagement", value: stats.userEngagement.toLocaleString(), change: "14%", sub: "+ 210 today", up: true },
          { icon: PieChart, label: "Traffic Sources", value: stats.trafficSources.toLocaleString(), change: "20%", sub: "+ 70 today", up: true },
          { icon: TrendingUpIcon, label: "Audience Growth", value: stats.audienceGrowth.toLocaleString(), change: "10%", sub: "- 60 today", up: false },
          { icon: BarChart3, label: "Content Performance", value: stats.contentPerformance.toLocaleString(), change: "27%", sub: "+ 760 today", up: true },
        ].map(({ icon: Icon, label, value, change, sub, up }) => (
          <div key={label} className="bg-card rounded-xl border border-border p-4 flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="font-poppins text-[12px] text-muted-foreground">{label}</span>
              <Icon className="w-4 h-4 text-primary" />
            </div>
            <span className="font-poppins text-[22px] font-bold text-foreground">{value}</span>
            <div className="flex items-center gap-2">
              <span className={`font-poppins text-[10px] font-semibold px-2 py-0.5 rounded-full ${up ? "bg-green-500/10 text-green-500" : "bg-red-500/10 text-red-500"}`}>
                {up ? "↑" : "↓"} {change}
              </span>
              <span className="font-poppins text-[10px] text-muted-foreground">{sub}</span>
            </div>
          </div>
        ))}
      </div>

      <div>
        <h3 className="font-poppins text-[14px] font-semibold text-foreground mb-3">Daily Action Items</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <button
            onClick={() => setShowAddPost(true)}
            className="flex items-center gap-3 bg-primary/8 hover:bg-primary/12 rounded-xl px-4 py-4 transition-colors text-left"
          >
            <div className="w-10 h-10 rounded-lg bg-white flex items-center justify-center shrink-0 shadow-sm">
              <FileEdit className="w-4.5 h-4.5 text-foreground" />
            </div>
            <div>
              <p className="font-poppins text-[13px] font-semibold text-foreground">Publish a post</p>
              <p className="font-poppins text-[11px] text-muted-foreground">Build connections with meaningful posts.</p>
            </div>
          </button>
          <button className="flex items-center gap-3 bg-primary/8 hover:bg-primary/12 rounded-xl px-4 py-4 transition-colors text-left">
            <div className="w-10 h-10 rounded-lg bg-white flex items-center justify-center shrink-0 shadow-sm">
              <MessageSquare className="w-4.5 h-4.5 text-foreground" />
            </div>
            <div>
              <p className="font-poppins text-[13px] font-semibold text-foreground">Comment on Posts</p>
              <p className="font-poppins text-[11px] text-muted-foreground">Build connections with meaningful posts.</p>
            </div>
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1.4fr_1fr] gap-4">
        <div className="bg-card rounded-xl border border-border p-4">
          <h3 className="font-poppins text-[13px] font-semibold text-foreground mb-4">Visit by Location</h3>
          <div className="flex flex-col md:flex-row gap-4 items-center">
            <div className="w-full md:w-[55%] shrink-0">
              <Image
                src="https://upload.wikimedia.org/wikipedia/commons/thumb/8/83/Equirectangular_projection_SW.jpg/1000px-Equirectangular_projection_SW.jpg"
                alt="World map"
                width={400}
                height={220}
                className="w-full h-auto rounded-lg opacity-80"
                style={{ filter: "grayscale(0.3) brightness(1.05)" }}
                unoptimized
              />
            </div>
            <div className="flex flex-col gap-2.5 w-full">
              {locations.length === 0 ? (
                <div className="text-center text-muted-foreground text-sm py-4">
                  No location data available
                </div>
              ) : (
                locations.map((loc) => (
                  <div key={loc.country} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-[14px]">{loc.flag}</span>
                      <span className="font-poppins text-[12px] text-foreground">{loc.country}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-poppins text-[12px] font-semibold text-foreground">{loc.value.toLocaleString()}</span>
                      <span className={`font-poppins text-[10px] font-semibold ${loc.up ? "text-green-500" : "text-red-500"}`}>
                        {loc.up ? "↑" : "↓"} {loc.change}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="bg-card rounded-xl border border-border p-4 flex flex-col gap-4">
          <h3 className="font-poppins text-[13px] font-semibold text-foreground">Social Media Audience</h3>
          <div>
            <span className="font-poppins text-[11px] text-muted-foreground">Total Audience</span>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="font-poppins text-[24px] font-bold text-foreground">{totalAudience.toLocaleString()}</span>
              {audienceChange && (
                <span className="font-poppins text-[10px] font-semibold text-green-500 bg-green-500/10 px-2 py-0.5 rounded-full">↑ {audienceChange}</span>
              )}
            </div>
          </div>
          {audienceBreakdown.length === 0 ? (
            <div className="text-center text-muted-foreground text-sm py-4">
              No audience data available
            </div>
          ) : (
            <>
              <div className="flex w-full h-2 rounded-full overflow-hidden">
                {audienceBreakdown.map((a) => (
                  <div key={a.platform} style={{ backgroundColor: a.color || "#3B82F6", flex: 1 }} />
                ))}
              </div>
              <div className="flex flex-col gap-2.5">
                {audienceBreakdown.map((a) => (
                  <div key={a.platform} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: a.color || "#3B82F6" }} />
                      <span className="font-poppins text-[12px] text-foreground">{a.platform}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-poppins text-[12px] font-semibold text-foreground">{a.value.toLocaleString()}</span>
                      <span className={`font-poppins text-[10px] font-semibold ${a.up ? "text-green-500" : "text-red-500"}`}>
                        {a.up ? "↑" : "↓"} {a.change}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      <div>
        <h3 className="font-poppins text-[14px] font-semibold text-foreground mb-3">Recommended for you</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <button className="flex items-center gap-3 bg-primary/8 hover:bg-primary/12 rounded-xl px-4 py-4 transition-colors text-left">
            <div className="w-10 h-10 rounded-lg bg-white flex items-center justify-center shrink-0 shadow-sm">
              <Sparkles className="w-4.5 h-4.5 text-primary" />
            </div>
            <div>
              <p className="font-poppins text-[13px] font-semibold text-foreground">Most Trending Posts</p>
              <p className="font-poppins text-[11px] text-muted-foreground">Build connections with meaningful posts.</p>
            </div>
          </button>
          <button className="flex items-center gap-3 bg-primary/8 hover:bg-primary/12 rounded-xl px-4 py-4 transition-colors text-left">
            <div className="w-10 h-10 rounded-lg bg-white flex items-center justify-center shrink-0 shadow-sm">
              <Sparkles className="w-4.5 h-4.5 text-primary" />
            </div>
            <div>
              <p className="font-poppins text-[13px] font-semibold text-foreground">Best Tags for your Posts</p>
              <p className="font-poppins text-[11px] text-muted-foreground">Build connections with meaningful posts.</p>
            </div>
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {PLATFORM_TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => handleTabChange(t.key)}
            className={`px-3.5 py-1.5 rounded-full text-[12px] font-poppins font-medium transition-colors flex items-center gap-1.5 ${
              activeTab === t.key ? "bg-primary text-white" : "bg-muted text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1.3fr_1fr] gap-4">
        <div className="bg-card rounded-xl border border-border p-4 flex flex-col gap-3">
          {recentUpload ? (
            <>
              <span className="font-poppins text-[11px] font-semibold text-primary">Recent Upload</span>
              <h4 className="font-poppins text-[16px] font-semibold text-foreground">{recentUpload.title}</h4>
              <p className="font-poppins text-[12px] text-muted-foreground leading-relaxed">
                {recentUpload.excerpt}
              </p>
              <div className="flex items-center justify-between mt-1">
                <div className="flex items-center">
                  <span className="font-poppins text-[11px] text-muted-foreground">
                    +{recentUpload.likesCount ?? 0} ❤️
                  </span>
                </div>
                <button
                  onClick={() => onViewDetail(activeTab === "All" ? "Instagram" : activeTab)}
                  className="px-4 py-1.5 bg-foreground text-white text-[11px] font-poppins font-semibold rounded-lg hover:bg-foreground/90 transition-colors"
                >
                  Details
                </button>
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm py-8">
              No recent uploads
            </div>
          )}
        </div>

        <EngagementChart />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1.4fr_1fr] gap-4">
        <div className="bg-card rounded-xl border border-border p-4 flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h3 className="font-poppins text-[13px] font-semibold text-foreground">Post Schedule</h3>
            <button className="flex items-center gap-1 font-poppins text-[12px] text-muted-foreground">
              {getCurrentMonthLabel()} <ChevronDown className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="flex items-center justify-between">
            <button className="text-primary"><ChevronLeft className="w-4 h-4" /></button>
            <div className="flex items-center gap-2 sm:gap-4 overflow-x-auto">
              {scheduleDays.map((d) => (
                <div key={d.date} className="flex flex-col items-center gap-1 shrink-0 w-10">
                  <span className="font-poppins text-[10px] text-muted-foreground">{d.day}</span>
                  <span className={`font-poppins text-[13px] font-semibold ${d.date === todayDate ? "text-primary" : "text-foreground"}`}>
                    {d.date}
                  </span>
                </div>
              ))}
            </div>
            <button className="text-primary"><ChevronRight className="w-4 h-4" /></button>
          </div>

          <div className="flex flex-col gap-3">
            {scheduleSlots.length === 0 ? (
              <div className="text-center text-muted-foreground text-sm py-8">
                No posts scheduled
              </div>
            ) : (
              scheduleSlots.map((slot, idx: number) => (
                <div key={idx}>
                  <span className="font-poppins text-[11px] text-muted-foreground">{slot.time}</span>
                  <div className={`grid grid-cols-1 ${slot.posts.length > 1 ? 'sm:grid-cols-2' : ''} gap-2.5 mt-1.5`}>
                    {slot.posts.map((post, pi: number) => (
                      <div key={pi} className="bg-muted/40 rounded-lg p-3 flex flex-col gap-2 border border-border">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-1.5">
                            <PlatformIcon platform={post.platform} size={12} />
                            <span className="font-poppins text-[11px] font-semibold text-foreground">{post.platform}</span>
                          </div>
                          <MoreVertical className="w-3.5 h-3.5 text-muted-foreground" />
                        </div>
                        <p className="font-poppins text-[10px] text-muted-foreground line-clamp-3">{post.text}</p>
                        {post.images && post.images.length > 0 && (
                          <div className="flex items-center gap-1">
                            {post.images.map((src: string, j: number) => (
                              <div key={j} className="w-7 h-7 rounded overflow-hidden">
                                <Image src={src} alt="" width={28} height={28} className="object-cover w-full h-full" unoptimized />
                              </div>
                            ))}
                            {post.extra > 0 && (
                              <span className="font-poppins text-[10px] font-semibold text-primary bg-primary/10 px-1.5 py-0.5 rounded">
                                {post.extra}+
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="bg-card rounded-xl border border-border p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h3 className="font-poppins text-[13px] font-semibold text-foreground">Post Insights</h3>
            <button className="flex items-center gap-1 font-poppins text-[11px] text-muted-foreground">
              {getLast30DaysLabel()} <ChevronDown className="w-3.5 h-3.5" />
            </button>
          </div>

          {insights.length === 0 ? (
            <div className="text-center text-muted-foreground text-sm py-8">
              No insights available
            </div>
          ) : (
            insights.map((ins) => (
              <div key={ins.platform} className="border border-border rounded-lg p-3 flex flex-col gap-2.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <PlatformIcon platform={ins.platform} size={13} />
                    <div>
                      <span className="font-poppins text-[12px] font-semibold text-foreground block">{ins.platform}</span>
                      <span className="font-poppins text-[10px] text-primary">{ins.posts} Posts</span>
                    </div>
                  </div>
                  <button
                    onClick={() => onViewDetail(ins.platform)}
                    className="px-2.5 py-1 bg-primary/10 text-primary text-[10px] font-poppins font-semibold rounded-full hover:bg-primary/20 transition-colors"
                  >
                    See detail
                  </button>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div className="flex flex-col">
                    <span className="font-poppins text-[12px] font-bold text-foreground">{ins.audience}</span>
                    <span className="font-poppins text-[9px] text-muted-foreground">Audience</span>
                  </div>
                  <div className="flex flex-col">
                    <span className="font-poppins text-[12px] font-bold text-foreground">{ins.totalLikes}</span>
                    <span className="font-poppins text-[9px] text-muted-foreground">Total Likes</span>
                  </div>
                  <div className="flex flex-col">
                    <span className="font-poppins text-[12px] font-bold text-foreground">{ins.followers}</span>
                    <span className="font-poppins text-[9px] text-muted-foreground">Followers</span>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {showAddAccount && <AddSocialAccountModal onClose={() => setShowAddAccount(false)} />}
      {showAddPost && <AddNewPostModal onClose={() => setShowAddPost(false)} />}
    </div>
  );
}