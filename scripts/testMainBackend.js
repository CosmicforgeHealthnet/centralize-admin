// scripts/testMainBackend.js
require("dotenv").config();

const mainApi = require("../src/shared/config/mainApi");

async function test() {
  console.log("🔍 Checking MAIN_BACKEND_URL:", process.env.MAIN_BACKEND_URL);
  console.log("─".repeat(50));

  const tests = [
    {
      name: "Get tickets (status: pending)",
      fn: () =>
        mainApi.get("/api/support/account", { params: { status: "pending" } }),
    },
    {
      name: "Get tickets (status: in_progress)",
      fn: () =>
        mainApi.get("/api/support/account", {
          params: { status: "in_progress" },
        }),
    },
    {
      name: "Get tickets (status: resolved)",
      fn: () =>
        mainApi.get("/api/support/account", { params: { status: "resolved" } }),
    },
    {
      name: "Get tickets (status: closed)",
      fn: () =>
        mainApi.get("/api/support/account", { params: { status: "closed" } }),
    },
    {
      name: "Get all tickets (no filter)",
      fn: () => mainApi.get("/api/support/account"),
    },
    {
      name: "Get all disputes (no filter)",
      fn: () => mainApi.get("/api/support/disputes"),
    },
    {
      name: "Get disputes (status: pending)",
      fn: () =>
        mainApi.get("/api/support/disputes", { params: { status: "pending" } }),
    },
  ];

  for (const t of tests) {
    try {
      const res = await t.fn();
      console.log(`✅ ${t.name}`);
      console.log(`   Status: ${res.status}`);
      const preview = JSON.stringify(res.data).slice(0, 120);
      console.log(
        `   Data:   ${preview}${preview.length === 120 ? "..." : ""}`,
      );
    } catch (err) {
      if (err.response) {
        const icon = err.response.status === 404 ? "⚠️ " : "❌";
        console.log(`${icon} ${t.name}`);
        console.log(`   Status: ${err.response.status}`);
        console.log(
          `   Body:   ${JSON.stringify(err.response.data).slice(0, 120)}`,
        );
      } else {
        console.log(`💀 ${t.name} — no response`);
        console.log(`   Code:    ${err.code}`);
        console.log(`   Message: ${err.message}`);
      }
    }
    console.log("─".repeat(50));
  }
}

test();
