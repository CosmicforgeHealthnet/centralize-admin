"use client";

import Image from "next/image";
import { useRef, useState } from "react";
import { Camera, Loader2, X, AlertCircle, Check } from "lucide-react";
import { useProfileStore } from "@/stores/profile.store";

export default function ProfileCard() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { profile, isLoading, isUpdatingAvatar, updateAvatar } = useProfileStore();
  
  // State for error/success prompts
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Auto-dismiss messages after 3 seconds
  const showError = (message: string) => {
    setErrorMessage(message);
    setTimeout(() => setErrorMessage(null), 3000);
  };

  const showSuccess = (message: string) => {
    setSuccessMessage(message);
    setTimeout(() => setSuccessMessage(null), 3000);
  };

  const handleAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    // Frontend validation - 1MB max
    const MAX_SIZE = 1 * 1024 * 1024; // 1MB
    if (file.size > MAX_SIZE) {
      showError(`File size is ${(file.size / (1024 * 1024)).toFixed(2)}MB. Maximum allowed is 1MB. Please compress your image.`);
      e.target.value = "";
      return;
    }
    
    const allowedTypes = ["image/jpeg", "image/png", "image/webp"];
    if (!allowedTypes.includes(file.type)) {
      showError("Only JPEG, PNG, and WEBP images are allowed");
      e.target.value = "";
      return;
    }
    
    try {
      await updateAvatar(file);
      showSuccess("Profile picture updated successfully!");
    } catch (error: unknown) {
      showError(error instanceof Error ? error.message : "Failed to upload avatar. Please try again.");
    }
    e.target.value = "";
  };

  const fields = [
    {
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="4" width="20" height="16" rx="2" />
          <path d="M7 15h.01M11 15h2M7 11h.01M11 11h2M7 7h.01M11 7h6" />
        </svg>
      ),
      label: "Employee ID:",
      value: profile?.mainAppUserId ? `#${profile.mainAppUserId}` : "—",
    },
    {
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6.62 10.79a15.053 15.053 0 006.59 6.59l2.2-2.2a1 1 0 011.01-.24c1.12.37 2.33.57 3.58.57a1 1 0 011 1V20a1 1 0 01-1 1C10.61 21 3 13.39 3 4a1 1 0 011-1h3.5a1 1 0 011 1c0 1.25.2 2.46.57 3.58a1 1 0 01-.25 1.01l-2.2 2.2z" />
        </svg>
      ),
      label: "Phone Number:",
      value: profile?.workPhone || profile?.personalPhone || "—",
    },
    {
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="4" width="20" height="16" rx="2" />
          <path d="M2 8l10 6 10-6" />
        </svg>
      ),
      label: "Email Address:",
      value: profile?.email || "—",
    },
    {
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="18" rx="2" />
          <path d="M16 2v4M8 2v4M3 10h18" />
        </svg>
      ),
      label: "Employment Date:",
      value: profile?.createdAt
        ? new Date(profile.createdAt).toLocaleDateString("en-GB", {
            day: "numeric",
            month: "long",
            year: "numeric",
          })
        : "—",
    },
    {
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="7" width="20" height="14" rx="2" />
          <path d="M16 7V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v2" />
        </svg>
      ),
      label: "Position:",
      value: profile?.position || "—",
    },
    {
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 21h18M9 21V7l6-4v18M9 11h6" />
        </svg>
      ),
      label: "Department:",
      value: profile?.department ? profile.department.replace(/_/g, " ") : "—",
    },
    {
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
        </svg>
      ),
      label: "Team Lead:",
      value: profile?.isTeamLead ? "Yes" : "No",
    },
  ];

  const avatarSrc = isLoading || profile === null ? null : profile.avatarUrl || "/profile-img.png";

  return (
    <div className="flex flex-col w-full sm:w-[200px] sm:shrink-0" style={{ gap: "12px" }}>

      {/* Toast notification for errors/success */}
      {(errorMessage || successMessage) && (
        <div className="fixed top-20 right-4 z-50 animate-in slide-in-from-top-2 fade-in duration-200">
          <div className={`rounded-lg shadow-lg p-4 flex items-center gap-3 min-w-[280px] max-w-[380px] ${
            errorMessage ? "bg-red-50 border border-red-200" : "bg-green-50 border border-green-200"
          }`}>
            {errorMessage ? (
              <AlertCircle className="w-5 h-5 text-red-500 shrink-0" />
            ) : (
              <div className="w-5 h-5 rounded-full bg-green-500 flex items-center justify-center shrink-0">
                <Check className="w-3 h-3 text-white" />
              </div>
            )}
            <p className={`text-sm flex-1 ${
              errorMessage ? "text-red-700" : "text-green-700"
            }`}>
              {errorMessage || successMessage}
            </p>
            <button
              onClick={() => {
                setErrorMessage(null);
                setSuccessMessage(null);
              }}
              className="shrink-0 hover:opacity-70"
            >
              <X className="w-4 h-4 text-gray-500" />
            </button>
          </div>
        </div>
      )}

      {/* Avatar */}
      <div
        className="relative overflow-hidden bg-muted w-full sm:w-[189px]"
        style={{ height: "214px", borderRadius: "10px" }}
      >
        {avatarSrc && (
          <Image
            key={avatarSrc}
            src={avatarSrc}
            alt={profile?.name || "Employee photo"}
            fill
            className="object-cover"
            priority
          />
        )}

        {/* Skeleton shimmer — shown while loading OR before profile arrives */}
        {(isLoading || profile === null) && (
          <div className="absolute inset-0 animate-pulse bg-muted" />
        )}

        {/* Upload-in-progress overlay - only for avatar updates */}
        {isUpdatingAvatar && (
          <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
            <Loader2 size={20} className="text-white animate-spin" />
          </div>
        )}

        {/* Size limit hint */}
        <div className="absolute bottom-3 left-3">
          <div className="relative group">
            <div className="bg-black/60 text-white text-[10px] px-2 py-1 rounded-md flex items-center gap-1 cursor-help">
              <AlertCircle size={10} />
              Max 1MB
            </div>
            {/* Tooltip on hover */}
            <div className="absolute bottom-full left-0 mb-2 hidden group-hover:block">
              <div className="bg-gray-900 text-white text-xs rounded px-3 py-2 whitespace-nowrap shadow-lg">
                Image must be under 1MB
                <br />
                Formats: JPEG, PNG, WEBP
              </div>
              <div className="w-2 h-2 bg-gray-900 rotate-45 absolute -bottom-1 left-3"></div>
            </div>
          </div>
        </div>

        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={isUpdatingAvatar || isLoading || profile === null}
          className="absolute bottom-3 right-3 w-10 h-10 bg-white/95 hover:bg-white rounded-full flex items-center justify-center shadow-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Camera size={18} className="text-foreground" />
        </button>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={handleAvatarChange}
        />
      </div>

      {/* Info card */}
      <div
        className="bg-card border border-border w-full sm:w-[200px]"
        style={{
          borderRadius: "10px",
          paddingTop: "19px",
          paddingRight: "12px",
          paddingBottom: "19px",
          paddingLeft: "12px",
          display: "flex",
          flexDirection: "column",
          gap: "26px",
          boxSizing: "border-box",
        }}
      >
        {fields.map((field) => (
          <div
            key={field.label}
            style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}
          >
            <span className="text-muted-foreground shrink-0" style={{ marginTop: "1px" }}>
              {field.icon}
            </span>
            <div style={{ display: "flex", flexDirection: "column", gap: "1px", minWidth: 0 }}>
              <span
                className="font-poppins text-muted-foreground"
                style={{ fontSize: "11px", fontWeight: 400, lineHeight: "1.3" }}
              >
                {field.label}
              </span>
              {/* Skeleton placeholder for field values while loading */}
              {isLoading || profile === null ? (
                <div className="h-3.5 w-24 rounded animate-pulse bg-muted mt-0.5" />
              ) : (
                <span
                  className="font-poppins text-foreground"
                  style={{ fontSize: "13px", fontWeight: 600, lineHeight: "1.3", wordBreak: "break-word" }}
                >
                  {field.value}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>

    </div>
  );
}