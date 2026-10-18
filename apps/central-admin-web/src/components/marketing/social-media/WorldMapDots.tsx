// src/components/marketing/social-media/WorldMapDots.tsx
"use client";

export default function WorldMapDots({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 1000 500"
      className={className}
      style={{ width: "100%", height: "auto" }}
      fill="none"
    >
      <path
        d="M60 90 L140 60 L220 70 L260 110 L250 160 L280 190 L260 230 L210 250 L180 220 L150 240 L110 210 L90 170 L50 150 Z"
        fill="#D6D9F5"
      />
      <path
        d="M230 270 L280 260 L310 300 L300 360 L280 420 L250 450 L230 400 L220 340 Z"
        fill="#D6D9F5"
      />
      <path
        d="M460 70 L520 60 L560 90 L550 120 L500 130 L470 110 Z"
        fill="#D6D9F5"
      />
      <path
        d="M470 150 L540 140 L580 180 L570 250 L540 320 L500 360 L470 320 L460 250 L450 190 Z"
        fill="#D6D9F5"
      />
      <path
        d="M580 60 L720 50 L820 90 L840 140 L780 170 L720 150 L660 170 L600 140 L570 100 Z"
        fill="#D6D9F5"
      />
      <path
        d="M700 220 L760 210 L800 240 L780 260 L720 250 Z"
        fill="#D6D9F5"
      />
      <path
        d="M790 320 L870 310 L900 340 L880 380 L820 390 L790 360 Z"
        fill="#D6D9F5"
      />
      <circle cx="740" cy="235" r="5" fill="#272EA7" />
      <circle cx="180" cy="150" r="5" fill="#272EA7" />
      <circle cx="850" cy="350" r="5" fill="#272EA7" />
      <circle cx="620" cy="90" r="5" fill="#272EA7" />
      <circle cx="740" cy="110" r="5" fill="#272EA7" />
      <circle cx="270" cy="400" r="5" fill="#272EA7" />
    </svg>
  );
}