// src/components/marketing/social-media/PostDetail.tsx
"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import { ArrowLeft, PlusCircle, Search, ChevronDown, SlidersHorizontal } from "lucide-react";
import AddSocialAccountModal from "./AddSocialAccountModal";
import { useMarketingStore } from "@/stores/marketing.store";
import { Skeleton } from "@/components/ui/skeleton";
import type { SocialPostListItem, SocialPostDetail } from "@/types/marketing.types";

const PLATFORM_TABS = ["All", "Youtube", "Twitter", "Instagram", "Tiktok", "LinkedIn"];

type SocialPost = SocialPostListItem | SocialPostDetail;

function isDetailPost(post: SocialPost): post is SocialPostDetail {
  return 'imageUrl' in post && 'description' in post;
}

interface Props {
  platform: string;
  onBack: () => void;
}

export default function PostDetail({ platform, onBack }: Props) {
  const [activeTab, setActiveTab] = useState(platform || "Instagram");
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");

  const {
    selectedSocialPost,
    socialPosts,
    isLoadingSocialPostDetail,
    isLoadingSocialPosts,
    fetchSocialPostDetail,
    fetchSocialPosts,
    setSocialPostFilters,
    error,
    clearError,
  } = useMarketingStore();

  useEffect(() => {
    // Update filters and fetch
    const platformValue = activeTab === "All" ? "All" : activeTab;
    setSocialPostFilters({ platform: platformValue as any, page: 1 });
    fetchSocialPosts();
  }, [activeTab, setSocialPostFilters, fetchSocialPosts]);

  useEffect(() => {
    if (selectedSocialPost?.id) {
      fetchSocialPostDetail(selectedSocialPost.id);
    }
  }, [selectedSocialPost?.id, fetchSocialPostDetail]);

  useEffect(() => {
    if (error) {
      const timer = setTimeout(() => clearError(), 5000);
      return () => clearTimeout(timer);
    }
  }, [error, clearError]);

  // Get the first post or use selected
  const post = selectedSocialPost || (socialPosts.length > 0 ? socialPosts[0] : null);
  const postsList = socialPosts;

  // Helper to get image URL
  const getImageUrl = (p: SocialPost | null): string | null => {
    if (!p) return null;
    if (isDetailPost(p)) {
      return p.imageUrl;
    }
    return p.thumbnailUrl;
  };

  // Helper to get description
  const getDescription = (p: SocialPost | null): string => {
    if (!p) return "";
    if (isDetailPost(p)) {
      return p.description;
    }
    return p.excerpt;
  };

  if (isLoadingSocialPostDetail && !post) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-6 w-32" />
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-4 w-32 mt-1" />
          </div>
          <Skeleton className="w-20 h-20 rounded-full" />
        </div>
        <Skeleton className="h-10 w-64" />
        <div className="grid grid-cols-1 lg:grid-cols-[1.6fr_1fr] gap-4">
          <Skeleton className="h-[480px] rounded-xl" />
          <Skeleton className="h-[480px] rounded-xl" />
        </div>
        <Skeleton className="h-[300px] rounded-xl" />
      </div>
    );
  }

  const imageUrl = getImageUrl(post);
  const description = getDescription(post);

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
          {error}
        </div>
      )}

      <button
        onClick={onBack}
        className="flex items-center gap-1.5 text-muted-foreground hover:text-primary transition-colors w-fit"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        <span className="font-poppins text-[12px] font-medium">Social Media</span>
      </button>

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="font-poppins text-[16px] font-semibold text-foreground">Post Details</h2>
          <p className="font-poppins text-[12px] text-muted-foreground mt-0.5">Manage your post progress here</p>
        </div>
        <button
          onClick={() => setShowAddAccount(true)}
          className="flex flex-col items-center gap-0.5 text-primary w-fit"
        >
          <div className="w-9 h-9 rounded-full border-2 border-primary flex items-center justify-center">
            <PlusCircle className="w-4 h-4" />
          </div>
          <span className="font-poppins text-[9px] font-semibold whitespace-nowrap">Link New Account</span>
        </button>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {PLATFORM_TABS.map((t) => (
          <button
            key={t}
            onClick={() => setActiveTab(t)}
            className={`px-3.5 py-1.5 rounded-full text-[12px] font-poppins font-medium transition-colors ${
              activeTab === t ? "bg-primary text-white" : "bg-muted text-muted-foreground hover:text-foreground"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1.6fr_1fr] gap-4">
        <div className="flex flex-col gap-3">
          <div className="rounded-xl overflow-hidden bg-muted h-[420px] sm:h-[480px]">
            {imageUrl ? (
              <Image
                src={imageUrl}
                alt="Post"
                width={900}
                height={900}
                className="object-cover w-full h-full"
                unoptimized
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-muted-foreground">
                No image available
              </div>
            )}
          </div>

          <div className="bg-card rounded-xl border border-border p-4">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-6 h-6 rounded-md flex items-center justify-center shrink-0" style={{ background: "linear-gradient(45deg,#f09433,#dc2743,#bc1888)" }}>
                <span className="text-white text-[10px] font-bold">I</span>
              </div>
              <div>
                <span className="font-poppins text-[12px] font-semibold text-foreground block">{activeTab}</span>
                <span className="font-poppins text-[10px] text-muted-foreground">{post?.postedAt || "Posted recently"}</span>
              </div>
            </div>
            <p className="font-poppins text-[12px] text-muted-foreground leading-relaxed mb-3">
              {description || "No description available"}
            </p>
            <div className="grid grid-cols-4 gap-2">
              {[
                { label: "Followers", value: post?.followers || "0" },
                { label: "Views", value: post?.views || "0" },
                { label: "Total Likes", value: post?.totalLikes || "0" },
                { label: "Comments", value: post?.comments || "0" },
              ].map(({ label, value }) => (
                <div key={label} className="flex flex-col">
                  <span className="font-poppins text-[13px] font-bold text-foreground">{value}</span>
                  <span className="font-poppins text-[10px] text-muted-foreground">{label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="bg-card rounded-xl border border-border p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h3 className="font-poppins text-[13px] font-semibold text-foreground">Posts</h3>
          </div>
          <div className="flex items-center gap-2 bg-muted border border-border rounded-lg px-3 h-[36px]">
            <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <input
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search"
              className="bg-transparent text-[12px] font-poppins text-foreground outline-none w-full placeholder:text-muted-foreground"
            />
          </div>

          <div className="bg-primary/8 rounded-lg p-3 flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-white flex items-center justify-center shrink-0">
              <SlidersHorizontal className="w-4 h-4 text-primary" />
            </div>
            <div>
              <p className="font-poppins text-[12px] font-semibold text-foreground">Publish a post</p>
              <p className="font-poppins text-[10px] text-muted-foreground">Build connections with meaningful posts.</p>
            </div>
          </div>

          <div className="flex flex-col gap-2.5 max-h-[520px] overflow-y-auto">
            {isLoadingSocialPosts ? (
              Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-[150px] rounded-xl" />
              ))
            ) : postsList.length === 0 ? (
              <div className="text-center text-muted-foreground text-sm py-8">
                No posts found
              </div>
            ) : (
              postsList.map((p) => (
                <div key={p.id} className="border border-border rounded-lg p-3 flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <div className="w-5 h-5 rounded flex items-center justify-center shrink-0" style={{ background: "linear-gradient(45deg,#f09433,#dc2743,#bc1888)" }}>
                        <span className="text-white text-[9px] font-bold">I</span>
                      </div>
                      <div>
                        <span className="font-poppins text-[11px] font-semibold text-foreground block">{p.platform}</span>
                        <span className="font-poppins text-[9px] text-muted-foreground">{p.postedAt || "Recently"}</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    {p.thumbnailUrl && (
                      <div className="w-10 h-10 rounded overflow-hidden shrink-0">
                        <Image src={p.thumbnailUrl} alt="" width={40} height={40} className="object-cover w-full h-full" unoptimized />
                      </div>
                    )}
                    <p className="font-poppins text-[9.5px] text-muted-foreground leading-snug line-clamp-3">{p.excerpt}</p>
                  </div>
                  <div className="grid grid-cols-4 gap-1">
                    {[
                      { label: "Followers", value: p.followers || "0" },
                      { label: "Views", value: p.views || "0" },
                      { label: "Likes", value: p.totalLikes || "0" },
                      { label: "Comments", value: p.comments || "0" },
                    ].map(({ label, value }) => (
                      <div key={label} className="flex flex-col">
                        <span className="font-poppins text-[10px] font-bold text-foreground">{value}</span>
                        <span className="font-poppins text-[8px] text-muted-foreground truncate">{label}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {showAddAccount && <AddSocialAccountModal onClose={() => setShowAddAccount(false)} />}
    </div>
  );
}