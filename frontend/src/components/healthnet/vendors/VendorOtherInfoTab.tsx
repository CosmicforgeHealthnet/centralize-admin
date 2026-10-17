"use client";

import { useState } from "react";
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Cell,
} from "recharts";
import Image from "next/image";

// ── Mock Data ────────────────────────────────────────────────────────────────

const SALES_ANALYTICS = [
  { month: "Jan", value: 1000 }, { month: "Feb", value: 1600 },
  { month: "Mar", value: 1500 }, { month: "Apr", value: 1900 },
  { month: "May", value: 1700 }, { month: "Jun", value: 3100 },
  { month: "Jul", value: 2800 }, { month: "Aug", value: 2400 },
  { month: "Sept", value: 1500 }, { month: "Oct", value: 3800 },
  { month: "Nov", value: 3900 }, { month: "Dec", value: 2900 },
];

const SALES_PERFORMANCE = [
  { month: "Jan", value: 20 }, { month: "Feb", value: 40 },
  { month: "Mar", value: 68 }, { month: "Apr", value: 28 },
  { month: "May", value: 95 }, { month: "Jun", value: 100 },
  { month: "Jul", value: 12 }, { month: "Aug", value: 55 },
  { month: "Sept", value: 72 }, { month: "Oct", value: 38 },
  { month: "Nov", value: 62 }, { month: "Dec", value: 83 },
];

interface Product {
  no: number;
  name: string;
  productId: string;
  status: "Available" | "Out of Stock" | "Limited";
  totalStock: number;
  price: string;
  sale: number;
  totalRevenue: string;
}

const PRODUCTS: Product[] = [
  { no: 1, name: "Ibuprofen 400mg", productId: "A66B209MNC", status: "Available",    totalStock: 200, price: "₦ 3,500.00", sale: 50,    totalRevenue: "₦ 175,000.00" },
  { no: 2, name: "Codeine 400mg",   productId: "A66B209MNC", status: "Out of Stock", totalStock: 0,   price: "₦ 3,500.00", sale: 1030,  totalRevenue: "₦ 175,000.00" },
  { no: 3, name: "Tylenol 400mg",   productId: "A66B209MNC", status: "Limited",      totalStock: 20,  price: "₦ 3,500.00", sale: 500,   totalRevenue: "₦ 175,000.00" },
  { no: 4, name: "Amoxicillin 500mg", productId: "B77C310NDE", status: "Available",  totalStock: 350, price: "₦ 2,800.00", sale: 120,   totalRevenue: "₦ 336,000.00" },
  { no: 5, name: "Paracetamol 500mg", productId: "C88D421OEF", status: "Limited",    totalStock: 45,  price: "₦ 1,200.00", sale: 800,   totalRevenue: "₦ 960,000.00" },
];

interface SaleHistory {
  no: number;
  orderId: string;
  date: string;
  status: "Paid" | "Pending" | "Failed";
  price: string;
  customerName: string;
  customerEmail: string;
}

const SALES_HISTORY: SaleHistory[] = [
  { no: 1, orderId: "#874333", date: "31/01/2025", status: "Paid",    price: "₦ 3,500.00", customerName: "Dr Josh Olawale", customerEmail: "rexyinc@gmail.com" },
  { no: 2, orderId: "#874334", date: "31/01/2025", status: "Paid",    price: "₦ 3,500.00", customerName: "Dr Josh Olawale", customerEmail: "rexyinc@gmail.com" },
  { no: 3, orderId: "#874335", date: "31/01/2025", status: "Pending", price: "₦ 2,800.00", customerName: "Dr Josh Olawale", customerEmail: "rexyinc@gmail.com" },
  { no: 4, orderId: "#874336", date: "01/02/2025", status: "Paid",    price: "₦ 1,200.00", customerName: "Dr Josh Olawale", customerEmail: "rexyinc@gmail.com" },
  { no: 5, orderId: "#874337", date: "01/02/2025", status: "Failed",  price: "₦ 5,000.00", customerName: "Dr Josh Olawale", customerEmail: "rexyinc@gmail.com" },
];

// ── Stat Cards ────────────────────────────────────────────────────────────────

function TotalProductsCard() {
  return (
    <div className="bg-card rounded-[16px] shadow-[0_1px_20px_0_rgba(0,0,0,0.06)] dark:shadow-[0_1px_20px_0_rgba(0,0,0,0.3)] p-4 flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-[10px] bg-[#1a7a3c] flex items-center justify-center shrink-0">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path d="M20 7H4C2.9 7 2 7.9 2 9V19C2 20.1 2.9 21 4 21H20C21.1 21 22 20.1 22 19V9C22 7.9 21.1 7 20 7Z" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M16 21V5C16 3.9 15.1 3 14 3H10C8.9 3 8 3.9 8 5V21" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
        <div>
          <p className="text-[12px] font-poppins text-muted-foreground">Total Products</p>
          <p className="text-[18px] font-poppins font-bold text-foreground leading-tight">1,456</p>
        </div>
      </div>
      <div className="border-t border-border pt-3 grid grid-cols-3 gap-2">
        {[["210", "Total"], ["210", "Sold Out"], ["210", "New Stock"]].map(([val, lbl]) => (
          <div key={lbl} className="flex flex-col gap-0.5">
            <span className="text-[14px] font-poppins font-bold text-foreground">{val}</span>
            <span className="text-[11px] font-poppins text-muted-foreground">{lbl}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TotalOrdersCard() {
  return (
    <div className="bg-card rounded-[16px] shadow-[0_1px_20px_0_rgba(0,0,0,0.06)] dark:shadow-[0_1px_20px_0_rgba(0,0,0,0.3)] p-4 flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-[10px] bg-[#3b3fd4] flex items-center justify-center shrink-0">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path d="M9 5H7C5.9 5 5 5.9 5 7V19C5 20.1 5.9 21 7 21H17C18.1 21 19 20.1 19 19V7C19 5.9 18.1 5 17 5H15" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M9 5C9 3.9 9.9 3 11 3H13C14.1 3 15 3.9 15 5C15 6.1 14.1 7 13 7H11C9.9 7 9 6.1 9 5Z" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M9 12H15M9 16H12" stroke="white" strokeWidth="2" strokeLinecap="round"/>
          </svg>
        </div>
        <div>
          <p className="text-[12px] font-poppins text-muted-foreground">Total Orders</p>
          <p className="text-[18px] font-poppins font-bold text-foreground leading-tight">1,456</p>
        </div>
      </div>
      <div className="border-t border-border pt-3 grid grid-cols-3 gap-2">
        {[["210", "Processing"], ["210", "Processed"], ["210", "Delivered"]].map(([val, lbl]) => (
          <div key={lbl} className="flex flex-col gap-0.5">
            <span className="text-[14px] font-poppins font-bold text-foreground">{val}</span>
            <span className="text-[11px] font-poppins text-muted-foreground">{lbl}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Custom Tooltip ────────────────────────────────────────────────────────────

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-card border border-border rounded-[8px] px-3 py-2 shadow-md">
      <p className="text-[11px] font-poppins text-muted-foreground">{label}</p>
      <p className="text-[13px] font-poppins font-semibold text-foreground">{payload[0].value.toLocaleString()}</p>
    </div>
  );
}

// ── Status Badge ──────────────────────────────────────────────────────────────

const STATUS_STYLES: Record<string, string> = {
  "Available":    "text-[#1a7a3c]",
  "Out of Stock": "text-destructive",
  "Limited":      "text-[#d97706]",
  "Paid":         "text-[#1a7a3c]",
  "Pending":      "text-[#d97706]",
  "Failed":       "text-destructive",
};

// ── Sub-tabs (Product Performance / Sales History) ────────────────────────────

type SubTab = "products" | "history";

export default function VendorOtherInfoTab() {
  const [subTab, setSubTab] = useState<SubTab>("products");
  const [analyticsYear, setAnalyticsYear] = useState("2024");

  return (
    <div className="flex flex-col gap-5">
      {/* Stat Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <TotalProductsCard />
        <TotalOrdersCard />
      </div>

      {/* Sales Analytics */}
      <div className="bg-card rounded-[16px] shadow-[0_1px_20px_0_rgba(0,0,0,0.06)] dark:shadow-[0_1px_20px_0_rgba(0,0,0,0.3)] p-5">
        <div className="flex items-start justify-between gap-4 mb-1">
          <div>
            <p className="text-[15px] font-poppins font-bold text-foreground">Sales Analytics</p>
            <p className="text-[12px] font-poppins text-muted-foreground">Keep Track of Sales</p>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-sm bg-[#8B8FD4]" />
              <span className="text-[11px] font-poppins text-muted-foreground">Sales progression</span>
            </div>
            <select
              value={analyticsYear}
              onChange={(e) => setAnalyticsYear(e.target.value)}
              className="text-[12px] font-poppins text-foreground bg-card border border-border rounded-[8px] px-2.5 py-1 outline-none cursor-pointer"
            >
              {["2022", "2023", "2024", "2025"].map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="h-[220px] sm:h-[260px] mt-4">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={SALES_ANALYTICS} margin={{ top: 5, right: 5, left: -10, bottom: 0 }}>
              <defs>
                <linearGradient id="vendorSalesGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#8B8FD4" stopOpacity={0.35} />
                  <stop offset="95%" stopColor="#8B8FD4" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize: 11, fontFamily: "Poppins", fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fontFamily: "Poppins", fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false}
                tickFormatter={(v) => v >= 1000 ? `${v / 1000}K` : `${v}`} />
              <Tooltip content={<ChartTooltip />} />
              <Area type="monotone" dataKey="value" stroke="#8B8FD4" strokeWidth={2} fill="url(#vendorSalesGrad)" dot={false} activeDot={{ r: 4, fill: "#8B8FD4" }} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Sales Performance */}
      <div className="bg-card rounded-[16px] shadow-[0_1px_20px_0_rgba(0,0,0,0.06)] dark:shadow-[0_1px_20px_0_rgba(0,0,0,0.3)] p-5">
        <div className="flex items-start justify-between gap-4 mb-1">
          <div>
            <p className="text-[15px] font-poppins font-bold text-foreground">Sales Performance</p>
            <p className="text-[12px] font-poppins text-muted-foreground">Sales Performance and Report</p>
          </div>
          <button className="flex items-center gap-1.5 text-[12px] font-poppins text-foreground border border-border rounded-[8px] px-3 py-1.5 hover:border-primary/40 transition-colors whitespace-nowrap">
            Download Report
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>
        </div>
        <div className="h-[220px] sm:h-[260px] mt-4">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={SALES_PERFORMANCE} margin={{ top: 5, right: 5, left: -15, bottom: 0 }} barSize={18}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize: 11, fontFamily: "Poppins", fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fontFamily: "Poppins", fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false}
                tickFormatter={(v) => `${v}%`} domain={[0, 100]} />
              <Tooltip content={<ChartTooltip />} />
              <Bar dataKey="value" radius={[6, 6, 6, 6]}>
                {SALES_PERFORMANCE.map((_, idx) => (
                  <Cell key={idx} fill="url(#barGrad)" />
                ))}
              </Bar>
              <defs>
                <linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%"   stopColor="#8B8FD4" stopOpacity={0.9} />
                  <stop offset="100%" stopColor="#c8caee" stopOpacity={0.4} />
                </linearGradient>
              </defs>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Product Performance / Sales History */}
      <div className="bg-card rounded-[16px] shadow-[0_1px_20px_0_rgba(0,0,0,0.06)] dark:shadow-[0_1px_20px_0_rgba(0,0,0,0.3)] overflow-hidden">
        {/* Sub-tabs */}
        <div className="flex border-b border-border overflow-x-auto">
          {([["products", "Product Performance"], ["history", "Sales/Purchase History"]] as [SubTab, string][]).map(([val, lbl]) => (
            <button
              key={val}
              onClick={() => setSubTab(val)}
              className={`relative px-5 py-4 text-[13px] font-poppins font-medium whitespace-nowrap transition-colors shrink-0 ${
                subTab === val ? "text-primary dark:text-white" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {lbl}
              {subTab === val && <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-primary dark:bg-white rounded-t-full" />}
            </button>
          ))}
        </div>

        <div className="p-5">
          {/* Product Performance Table */}
          {subTab === "products" && (
            <>
              <p className="text-[14px] font-poppins font-semibold text-foreground mb-4">Products</p>
              {/* Desktop */}
              <div className="hidden sm:block overflow-x-auto">
                <table className="min-w-[700px] w-full">
                  <thead>
                    <tr className="border-b border-border">
                      {["No", "Product Name", "Product ID", "Status", "Total Stock", "Price", "Sale", "Total Revenue"].map((h) => (
                        <th key={h} className="py-2.5 pr-4 text-left text-[11px] font-poppins font-semibold text-muted-foreground whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {PRODUCTS.map((p) => (
                      <tr key={p.no} className="border-b border-border last:border-0 hover:bg-muted/40 transition-colors">
                        <td className="py-3 pr-4 text-[12px] font-poppins text-muted-foreground">{p.no}</td>
                        <td className="py-3 pr-4">
                          <div className="flex items-center gap-2">
                            <div className="w-8 h-8 rounded-[6px] bg-muted flex items-center justify-center shrink-0">
                              <span className="text-[10px]">💊</span>
                            </div>
                            <span className="text-[12px] font-poppins font-medium text-foreground whitespace-nowrap">{p.name}</span>
                          </div>
                        </td>
                        <td className="py-3 pr-4 text-[12px] font-poppins text-muted-foreground whitespace-nowrap">{p.productId}</td>
                        <td className="py-3 pr-4">
                          <span className={`text-[12px] font-poppins font-medium whitespace-nowrap ${STATUS_STYLES[p.status]}`}>{p.status}</span>
                        </td>
                        <td className="py-3 pr-4 text-[12px] font-poppins text-muted-foreground">{p.totalStock}</td>
                        <td className="py-3 pr-4 text-[12px] font-poppins text-muted-foreground whitespace-nowrap">{p.price}</td>
                        <td className="py-3 pr-4 text-[12px] font-poppins text-muted-foreground">{p.sale.toLocaleString()}</td>
                        <td className="py-3 text-[12px] font-poppins text-foreground font-medium whitespace-nowrap">{p.totalRevenue}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {/* Mobile */}
              <div className="sm:hidden flex flex-col gap-3">
                {PRODUCTS.map((p) => (
                  <div key={p.no} className="p-3 rounded-[10px] border border-border">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <div className="w-8 h-8 rounded-[6px] bg-muted flex items-center justify-center">
                          <span className="text-[10px]">💊</span>
                        </div>
                        <span className="text-[13px] font-poppins font-semibold text-foreground">{p.name}</span>
                      </div>
                      <span className={`text-[11px] font-poppins font-medium ${STATUS_STYLES[p.status]}`}>{p.status}</span>
                    </div>
                    <div className="grid grid-cols-2 gap-1.5 pl-10">
                      <span className="text-[11px] font-poppins text-muted-foreground">ID: {p.productId}</span>
                      <span className="text-[11px] font-poppins text-muted-foreground">Stock: {p.totalStock}</span>
                      <span className="text-[11px] font-poppins text-muted-foreground">Price: {p.price}</span>
                      <span className="text-[11px] font-poppins text-muted-foreground">Sale: {p.sale.toLocaleString()}</span>
                      <span className="text-[11px] font-poppins font-medium text-foreground col-span-2">Revenue: {p.totalRevenue}</span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* Sales History Table */}
          {subTab === "history" && (
            <>
              <p className="text-[14px] font-poppins font-semibold text-foreground mb-4">Sales History</p>
              {/* Desktop */}
              <div className="hidden sm:block overflow-x-auto">
                <table className="min-w-[600px] w-full">
                  <thead>
                    <tr className="border-b border-border">
                      {["No", "Order ID", "Date", "Status", "Price", "Customer"].map((h) => (
                        <th key={h} className="py-2.5 pr-4 text-left text-[11px] font-poppins font-semibold text-muted-foreground whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {SALES_HISTORY.map((s) => (
                      <tr key={s.no} className="border-b border-border last:border-0 hover:bg-muted/40 transition-colors">
                        <td className="py-3 pr-4 text-[12px] font-poppins text-muted-foreground">{s.no}</td>
                        <td className="py-3 pr-4 text-[12px] font-poppins text-foreground font-medium">{s.orderId}</td>
                        <td className="py-3 pr-4 text-[12px] font-poppins text-muted-foreground whitespace-nowrap">{s.date}</td>
                        <td className="py-3 pr-4">
                          <span className={`text-[12px] font-poppins font-medium ${STATUS_STYLES[s.status]}`}>{s.status}</span>
                        </td>
                        <td className="py-3 pr-4 text-[12px] font-poppins text-muted-foreground whitespace-nowrap">{s.price}</td>
                        <td className="py-3">
                          <div className="flex items-center gap-2">
                            <div className="w-7 h-7 rounded-full bg-secondary shrink-0 flex items-center justify-center">
                              <span className="text-[10px] font-bold text-primary font-poppins">D</span>
                            </div>
                            <div>
                              <p className="text-[12px] font-poppins font-medium text-foreground whitespace-nowrap">{s.customerName}</p>
                              <p className="text-[11px] font-poppins text-muted-foreground">{s.customerEmail}</p>
                            </div>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {/* Mobile */}
              <div className="sm:hidden flex flex-col gap-3">
                {SALES_HISTORY.map((s) => (
                  <div key={s.no} className="p-3 rounded-[10px] border border-border">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[13px] font-poppins font-semibold text-foreground">{s.orderId}</span>
                      <span className={`text-[11px] font-poppins font-medium ${STATUS_STYLES[s.status]}`}>{s.status}</span>
                    </div>
                    <div className="flex items-center gap-2 mb-2">
                      <div className="w-6 h-6 rounded-full bg-secondary flex items-center justify-center">
                        <span className="text-[9px] font-bold text-primary font-poppins">D</span>
                      </div>
                      <div>
                        <p className="text-[11px] font-poppins font-medium text-foreground">{s.customerName}</p>
                        <p className="text-[10px] font-poppins text-muted-foreground">{s.customerEmail}</p>
                      </div>
                    </div>
                    <div className="flex gap-4">
                      <span className="text-[11px] font-poppins text-muted-foreground">{s.date}</span>
                      <span className="text-[11px] font-poppins font-medium text-foreground">{s.price}</span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}