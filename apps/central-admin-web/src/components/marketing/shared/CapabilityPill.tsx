"use client";

export type CapabilityState =
  | "AVAILABLE"
  | "READ_ONLY"
  | "REQUIRES_REAUTHORIZATION"
  | "REQUIRES_PLATFORM_APPROVAL"
  | "RATE_LIMITED"
  | "NATIVE_ONLY"
  | "UNSUPPORTED_ACCOUNT_TYPE"
  | "DISABLED_BY_POLICY";

const CAPABILITY_STYLE: Record<CapabilityState, { label: string; bg: string; text: string }> = {
  AVAILABLE:                   { label: "Available",              bg: "rgba(13,165,63,0.1)",  text: "#0DA53F" },
  READ_ONLY:                   { label: "Read only",               bg: "rgba(148,163,184,0.15)", text: "#64748B" },
  REQUIRES_REAUTHORIZATION:    { label: "Reconnect required",      bg: "rgba(239,68,68,0.1)",  text: "#EF4444" },
  REQUIRES_PLATFORM_APPROVAL:  { label: "Approval required",       bg: "rgba(232,182,0,0.12)", text: "#E8B600" },
  RATE_LIMITED:                { label: "Rate limited",            bg: "rgba(232,182,0,0.12)", text: "#E8B600" },
  NATIVE_ONLY:                 { label: "Native only",             bg: "rgba(124,58,237,0.1)", text: "#7C3AED" },
  UNSUPPORTED_ACCOUNT_TYPE:    { label: "Unsupported account",     bg: "rgba(148,163,184,0.15)", text: "#64748B" },
  DISABLED_BY_POLICY:          { label: "Disabled",                bg: "rgba(148,163,184,0.15)", text: "#64748B" },
};

interface CapabilityPillProps {
  state: CapabilityState;
  reason?: string;
}

export default function CapabilityPill({ state, reason }: CapabilityPillProps) {
  const style = CAPABILITY_STYLE[state];
  if (!style) return null;

  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full font-poppins text-[10px] font-semibold w-fit"
      style={{ backgroundColor: style.bg, color: style.text }}
      title={reason}
    >
      {style.label}
      {reason && <span className="font-normal opacity-80">— {reason}</span>}
    </span>
  );
}