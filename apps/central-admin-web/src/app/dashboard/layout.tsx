"use client";

import { useState } from "react";
import Sidebar from "@/components/dashboard/Sidebar";
import Navbar from "@/components/dashboard/Navbar";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  return (
    /*
      CSS custom property --sw (sidebar width) drives everything.
      The grid spacer column matches the fixed sidebar width exactly.
      On tablet (md) the sidebar is always 72px icon-only → --sw is always 72px.
      On mobile the sidebar is an overlay → --sw is 0px, main takes full width.

      We set the variable on the wrapper so the Navbar and main
      both inherit it without any JS math at all.
    */
    <div
      className="dashboard-root"
      data-collapsed={collapsed ? "true" : "false"}
    >
      <style>{`
        .dashboard-root {
          --sw: 284px;
          display: grid;
          grid-template-columns: var(--sw) 1fr;
          grid-template-rows: auto 1fr;
          min-height: 100vh;
          background: var(--color-muted, #f4f4f5);
          transition: grid-template-columns 300ms ease-in-out;
        }
        /* Collapsed desktop sidebar */
        .dashboard-root[data-collapsed="true"] {
          --sw: 72px;
        }
        /* Mid-size: always icon-only, no toggle */
        @media (max-width: 1116px) and (min-width: 768px) {
          .dashboard-root {
            --sw: 72px !important;
          }
        }
        /* Mobile: sidebar is full overlay, main is full width */
        @media (max-width: 767px) {
          .dashboard-root {
            --sw: 0px !important;
            grid-template-columns: 1fr;
          }
        }
        .dashboard-navbar {
          grid-column: 2;
          grid-row: 1;
          position: sticky;
          top: 0;
          z-index: 40;
          min-width: 0;
        }
        @media (max-width: 767px) {
          .dashboard-navbar {
            grid-column: 1;
          }
        }
        .dashboard-main {
          grid-column: 2;
          grid-row: 2;
          min-width: 0;
          min-height: 0;
          overflow-x: hidden;
          padding: 1rem;
        }
        @media (min-width: 768px) {
          .dashboard-main {
            padding: 1.5rem;
          }
        }
        @media (max-width: 767px) {
          .dashboard-main {
            grid-column: 1;
          }
        }
      `}</style>

      {/* Sidebar — fixed position, width driven by CSS var on parent */}
      <Sidebar
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed((c) => !c)}
      />

      {/* Navbar sits in grid col 2, row 1 */}
      <div className="dashboard-navbar">
        <Navbar onMenuClick={() => setMobileOpen(true)} />
      </div>

      {/* Main content sits in grid col 2, row 2 */}
      <main className="dashboard-main">
        {children}
      </main>
    </div>
  );
}