import fs from "node:fs";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..", "src");
const tooltip = [
"components/healthnet/dashboard/HealthnetRevenueTracking.tsx",
"components/healthnet/dashboard/PatientsStatisticsChart.tsx",
"components/healthnet/vendors/VendorOtherInfoTab.tsx",
"components/hr/attendance/AttendanceDetail.tsx",
"components/hr/leaves/LeavesPage.tsx",
"components/hr/overview/HRPerformanceChart.tsx",
"components/hr/overview/HRSalaryChart.tsx",
"components/hr/payroll/PayrollEmployeeDetail.tsx",
"components/hr/performance/PerformanceOverview.tsx",
"components/marketing/content-manager/ContentDetail.tsx",
"components/marketing/overview/AdsPerformanceCharts.tsx",
"components/marketing/performance-dashboard/PerformanceDashboardPage.tsx",
"components/marketing/social-media/EngagementChart.tsx",
];
let changed=0;
for(const rel of tooltip) {
  const file=path.join(root,rel);const before=fs.readFileSync(file,"utf8");
  let after=before.replace(/(\{\s*active,\s*payload,\s*label\s*\}:\s*)any\b/g,"$1AdminChartTooltipProps");
  after=after.replace(/payload\.map\(\(p:\s*any\)/g,"payload.map((p)");
  if(after!==before) {
    after='import type { AdminChartTooltipProps } from "@/types/chart-tooltip.types";\n'+after;
    fs.writeFileSync(file,after);changed++;
  }
}
const inference=[
"components/marketing/performance-dashboard/PerformanceDashboardPage.tsx",
"components/marketing/social-media/EngagementChart.tsx",
"components/marketing/social-media/SocialMediaOverview.tsx",
"components/verification/VerificationDetail.tsx"
];
for(const rel of inference){
  const file=path.join(root,rel);const before=fs.readFileSync(file,"utf8");
  const after=before.replace(/\.map\(\(([a-zA-Z_$][\w$]*):\s*any\b/g,".map(($1");
  if(before!==after){fs.writeFileSync(file,after);changed++;}
}
console.log("Typed chart tooltips and contextually inferred map items in",changed,"files");
