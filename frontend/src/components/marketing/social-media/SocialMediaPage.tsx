// src/components/marketing/social-media/SocialMediaPage.tsx
"use client";

import { useState } from "react";
import SocialMediaOverview from "./SocialMediaOverview";
import PostDetail from "./PostDetail";

export default function SocialMediaPage() {
  const [view, setView] = useState<"overview" | "detail">("overview");
  const [activePlatform, setActivePlatform] = useState("Instagram");

  if (view === "detail") {
    return (
      <PostDetail
        platform={activePlatform}
        onBack={() => setView("overview")}
      />
    );
  }

  return (
    <SocialMediaOverview
      onViewDetail={(platform) => {
        setActivePlatform(platform);
        setView("detail");
      }}
    />
  );
}