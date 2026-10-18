"use client";

import { Lock } from "lucide-react";

interface PermissionGateProps {
  hasPermission: boolean;
  requiredGrant?: string;
  mode?: "hide" | "disable";
  children: React.ReactNode;
}

// The backend's 403 is always authoritative — this only improves the UX by
// hiding/disabling actions the current user's resolved grants don't cover.
export default function PermissionGate({ hasPermission, requiredGrant, mode = "disable", children }: PermissionGateProps) {
  if (hasPermission) return <>{children}</>;

  if (mode === "hide") return null;

  return (
    <div className="relative inline-flex items-center gap-1.5 opacity-50 cursor-not-allowed" title={requiredGrant ? `Requires ${requiredGrant}` : "Insufficient permission"}>
      <Lock className="w-3 h-3 text-muted-foreground" />
      <div className="pointer-events-none">{children}</div>
    </div>
  );
}