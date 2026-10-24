"use strict";

// Only approved administrative aggregates may cross this boundary.
// Anything not explicitly listed is discarded; no patient/clinical records.
const requiredNumbers = (obj, keys) => obj && typeof obj === "object" &&
  !Array.isArray(obj) && keys.every(key => typeof obj[key] === "number" &&
    Number.isFinite(obj[key]));

function adapt(operation, value) {
  // Accept a versioned owner API envelope OR a top-level owner payload.
  const record = value && typeof value === "object" && value.success === true && "data" in value
    ? value.data : value;
  if (operation === "/v1/dashboard/metrics") {
    const keys = ["totalAppointments", "totalDoctors", "totalPatients", "balance"];
    if (!requiredNumbers(record, keys) ||
        ["totalAppointments", "totalDoctors", "totalPatients"].some(key => record[key] < 0)) return null;
    return Object.fromEntries(keys.map(key => [key, record[key]]));
  }
  if (operation === "/v1/dashboard/charts/activity") {
    const keys = ["totalDoctors", "newDoctors", "appointments", "productPurchase"];
    if (!record || typeof record.month !== "string" || record.month.length > 20 ||
        !requiredNumbers(record, keys) || keys.some(key => record[key] < 0)) return null;
    return { month: record.month, ...Object.fromEntries(keys.map(key => [key, record[key]])) };
  }
  if (operation === "/v1/dashboard/charts/patients") {
    if (!record || typeof record.selectedMonth !== "string" ||
        record.selectedMonth.length > 20 || !Array.isArray(record.data) ||
        record.data.length > 24) return null;
    if (!record.data.every(item => typeof item?.month === "string" && item.month.length <= 20 &&
      typeof item.value === "number" && Number.isFinite(item.value) &&
      item.value >= 0 && item.value <= 100)) return null;
    return { selectedMonth: record.selectedMonth,
      data: record.data.map(item => ({ month: item.month, value: item.value })) };
  }
  if (operation === "/v1/dashboard/charts/revenue") {
    if (!record || !Array.isArray(record.data) || record.data.length > 60) return null;
    const keys = ["incomeUsd", "incomeNgn", "expenseUsd", "expenseNgn"];
    if (!record.data.every(item => typeof item?.month === "string" && item.month.length <= 20 &&
      requiredNumbers(item, keys) && keys.every(key => item[key] >= 0))) return null;
    return { data: record.data.map(item => ({ month: item.month,
      ...Object.fromEntries(keys.map(key => [key, item[key]])) })) };
  }
  return null;
}

module.exports = { adapt };
