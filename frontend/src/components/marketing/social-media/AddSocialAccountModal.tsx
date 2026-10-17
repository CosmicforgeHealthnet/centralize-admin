// src/components/marketing/social-media/AddSocialAccountModal.tsx
"use client";

import { useState } from "react";
import { ChevronDown, X, Eye, EyeOff } from "lucide-react";
import { useMarketingStore } from "@/stores/marketing.store";
import type { SocialPlatform } from "@/types/marketing.types";

const SOCIAL_PLATFORMS: Array<{ value: SocialPlatform; label: string; color: string }> = [
  { value: "Facebook", label: "Facebook", color: "#1877F2" },
  { value: "Instagram", label: "Instagram", color: "linear-gradient(45deg,#f09433,#dc2743,#bc1888)" },
  { value: "Twitter", label: "Twitter", color: "#000000" },
  { value: "Tiktok", label: "TikTok", color: "#000000" },
  { value: "LinkedIn", label: "LinkedIn", color: "#0A66C2" },
  { value: "Youtube", label: "YouTube", color: "#FF0000" },
];

interface Props {
  onClose: () => void;
}

export default function AddSocialAccountModal({ onClose }: Props) {
  const [platform, setPlatform] = useState<SocialPlatform | "">("");
  const [platformOpen, setPlatformOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [saveCredentials, setSaveCredentials] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const { createSocialAccount, error } = useMarketingStore();

  const handleConnect = async () => {
    if (!platform || !username || !password) return;

    setIsSubmitting(true);
    try {
      await createSocialAccount({
        platform: platform,
        username,
        password,
        saveCredentials,
      });
      onClose();
    } catch (err) {
      // Error handled by store
    } finally {
      setIsSubmitting(false);
    }
  };

  const selectedPlatform = SOCIAL_PLATFORMS.find(p => p.value === platform);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-xl w-full max-w-[480px] p-5 sm:p-6 flex flex-col gap-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h3 className="font-poppins text-[15px] font-semibold text-foreground">Link New Social Account</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-lg text-sm">
            {error}
          </div>
        )}

        <p className="font-poppins text-[12px] text-muted-foreground">
          Connect your social media account to manage posts and analytics
        </p>

        <div className="flex flex-col gap-1.5 relative">
          <label className="font-poppins text-[12px] font-medium text-foreground">Select Platform</label>
          <button
            onClick={() => setPlatformOpen((v) => !v)}
            className="w-full h-[44px] px-3.5 bg-muted/50 border border-border rounded-lg text-[13px] font-poppins text-left outline-none flex items-center justify-between transition-colors hover:border-primary/40"
          >
            <div className="flex items-center gap-2.5">
              {selectedPlatform && (
                <div
                  className="w-6 h-6 rounded flex items-center justify-center text-white font-bold text-[10px] shrink-0"
                  style={{ background: selectedPlatform.color }}
                >
                  {selectedPlatform.label.charAt(0)}
                </div>
              )}
              <span className={platform ? "text-foreground" : "text-muted-foreground"}>
                {platform || "Select Platform"}
              </span>
            </div>
            <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${platformOpen ? "rotate-180" : ""}`} />
          </button>
          {platformOpen && (
            <div className="absolute top-[72px] left-0 right-0 z-10 bg-card border border-border rounded-lg shadow-lg py-1.5 max-h-[200px] overflow-y-auto">
              {SOCIAL_PLATFORMS.map((p) => (
                <button
                  key={p.value}
                  onClick={() => { setPlatform(p.value); setPlatformOpen(false); }}
                  className="w-full text-left px-3.5 py-2.5 text-[13px] font-poppins text-foreground hover:bg-muted/50 transition-colors flex items-center gap-2.5"
                >
                  <div
                    className="w-6 h-6 rounded flex items-center justify-center text-white font-bold text-[10px] shrink-0"
                    style={{ background: p.color }}
                  >
                    {p.label.charAt(0)}
                  </div>
                  {p.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="font-poppins text-[12px] font-medium text-foreground">Username / Email</label>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Enter your username or email"
            className="w-full h-[44px] px-3.5 bg-muted/50 border border-border rounded-lg text-[13px] font-poppins text-foreground outline-none focus:border-primary/50 transition-colors placeholder:text-muted-foreground"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="font-poppins text-[12px] font-medium text-foreground">Password</label>
          <div className="flex items-center bg-muted/50 border border-border rounded-lg focus-within:border-primary/50 transition-colors">
            <input
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your password"
              className="w-full h-[44px] px-3.5 bg-transparent text-[13px] font-poppins text-foreground outline-none placeholder:text-muted-foreground"
            />
            <button
              onClick={() => setShowPassword(!showPassword)}
              className="px-3 text-muted-foreground hover:text-foreground transition-colors"
            >
              {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>

        <label className="flex items-center gap-2.5 cursor-pointer">
          <input
            type="checkbox"
            checked={saveCredentials}
            onChange={(e) => setSaveCredentials(e.target.checked)}
            className="w-4 h-4 rounded border-border accent-primary cursor-pointer"
          />
          <span className="font-poppins text-[12px] text-foreground">Save credentials for future use</span>
        </label>

        <button
          onClick={handleConnect}
          disabled={!platform || !username || !password || isSubmitting}
          className="w-full py-3 bg-primary text-white rounded-lg text-[13px] font-poppins font-semibold hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed mt-1"
        >
          {isSubmitting ? "Connecting..." : "Connect Account"}
        </button>

        <p className="font-poppins text-[10px] text-muted-foreground text-center">
          Your credentials are encrypted and secure. We only use them to post on your behalf.
        </p>
      </div>
    </div>
  );
}