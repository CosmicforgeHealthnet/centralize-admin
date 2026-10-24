# HealthNet Admin — verified staging HTTP route inventory

Source: services/central-admin-api/src/modules/healthnet/healthnet.routes.js on staging, 2026-10-24.
Status: mechanical route extraction, NOT certified contract/authority migration.
Legacy mount path: /api/healthnet. All listed operations are GET.
All routes currently inherit authenticate, requireTier(ADMIN), rate limiting and the new dependency boundary in the draft PR.

| # | Route | Controller |
|---:|---|---|
| 1 | `GET /api/healthnet/labs` | `getLabs` |
| 2 | `GET /api/healthnet/labs/:id/staff` | `getLabStaff` |
| 3 | `GET /api/healthnet/labs/:id/documents` | `getLabDocuments` |
| 4 | `GET /api/healthnet/labs/:id` | `getLabById` |
| 5 | `GET /api/healthnet/pharmacies` | `getPharmacies` |
| 6 | `GET /api/healthnet/pharmacies/:id/staff` | `getPharmacyStaff` |
| 7 | `GET /api/healthnet/pharmacies/:id/documents` | `getPharmacyDocuments` |
| 8 | `GET /api/healthnet/pharmacies/:id` | `getPharmacyById` |
| 9 | `GET /api/healthnet/vendors` | `getVendors` |
| 10 | `GET /api/healthnet/vendors/:id/documents` | `getVendorDocuments` |
| 11 | `GET /api/healthnet/vendors/:id/products` | `getVendorProducts` |
| 12 | `GET /api/healthnet/vendors/:id/orders` | `getVendorOrders` |
| 13 | `GET /api/healthnet/vendors/:id/analytics` | `getVendorAnalytics` |
| 14 | `GET /api/healthnet/vendors/:id/performance` | `getVendorPerformance` |
| 15 | `GET /api/healthnet/vendors/:id/stats` | `getVendorStats` |
| 16 | `GET /api/healthnet/vendors/:id` | `getVendorById` |
| 17 | `GET /api/healthnet/finance/stats` | `getFinanceStats` |
| 18 | `GET /api/healthnet/finance/revenue-tracking` | `getFinanceRevenueTracking` |
| 19 | `GET /api/healthnet/finance/appointments-history` | `getFinanceAppointmentsHistory` |
| 20 | `GET /api/healthnet/finance/subscriptions-history` | `getFinanceSubscriptionsHistory` |
| 21 | `GET /api/healthnet/finance/sales-history` | `getFinanceSalesHistory` |
| 22 | `GET /api/healthnet/analytics/stats` | `getAnalyticsStats` |
| 23 | `GET /api/healthnet/analytics/doctors-percentage` | `getAnalyticsDoctorsPercentage` |
| 24 | `GET /api/healthnet/analytics/patients-statistics` | `getAnalyticsPatientsStatistics` |
| 25 | `GET /api/healthnet/analytics/revenue-tracking` | `getAnalyticsRevenueTracking` |
| 26 | `GET /api/healthnet/analytics/appointments-overview` | `getAnalyticsAppointmentsOverview` |
| 27 | `GET /api/healthnet/analytics/sales-analytics` | `getAnalyticsSalesAnalytics` |
| 28 | `GET /api/healthnet/analytics/delivery-overview` | `getAnalyticsDeliveryOverview` |
| 29 | `GET /api/healthnet/analytics/billing-memberships` | `getAnalyticsBillingMemberships` |
| 30 | `GET /api/healthnet/patients` | `getPatients` |
| 31 | `GET /api/healthnet/patients/:id/appointments` | `getPatientAppointmentsTimeline` |
| 32 | `GET /api/healthnet/patients/:id/medical-history` | `getPatientMedicalHistory` |
| 33 | `GET /api/healthnet/patients/:id/records` | `getPatientRecords` |
| 34 | `GET /api/healthnet/patients/:id` | `getPatientById` |
| 35 | `GET /api/healthnet/doctors` | `getDoctors` |
| 36 | `GET /api/healthnet/doctors/:id/appointments` | `getDoctorAppointmentsTimeline` |
| 37 | `GET /api/healthnet/doctors/:id/certifications` | `getDoctorCertifications` |
| 38 | `GET /api/healthnet/doctors/:id/ratings` | `getDoctorRatings` |
| 39 | `GET /api/healthnet/doctors/:id` | `getDoctorById` |
| 40 | `GET /api/healthnet/appointments/search` | `searchAppointments` |
| 41 | `GET /api/healthnet/appointments` | `getAppointments` |
| 42 | `GET /api/healthnet/dashboard/metrics` | `getDashboardMetrics` |
| 43 | `GET /api/healthnet/dashboard/charts/activity` | `getActivityChart` |
| 44 | `GET /api/healthnet/dashboard/charts/patients` | `getPatientsChart` |
| 45 | `GET /api/healthnet/dashboard/charts/revenue` | `getRevenueChart` |

## Extraction ownership / compliance checklist

For EACH route record: request params, auth/RBAC/section policy, response schema, field-level privacy, pagination, empty vs unavailable behavior, CSV/downloads, upstream owner API, mainPrisma tables touched, query performance, audit and correlation IDs, data retention, and old/new parity fixture.

The HQ dashboard (/api/dashboard/*), users (/api/users/*), telemedicine (/api/telemedicine/*), RTC (/api/rtc/*), appointments client (/api/appointments/*), and verification flows are NOT included in the 45 HealthNet routes. They require a separate cross-module transitive dependency inventory before HQ-to-product DB access can be retired.

**No endpoint is cleared for cutover solely because it appears on this list.** Owner-approved versioned product Admin contracts and live source parity are mandatory. The HealthNet source VPS is currently offline.

Reference: docs/healthnet-admin-microservice-extraction-plan.md.