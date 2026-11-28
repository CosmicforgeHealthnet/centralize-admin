import { test, expect, signIn, defaultMocks, gotoWithEntitlements, ok, SUPER_USER, noHorizontalScroll } from "./fixtures";
import { cfmeetCapabilities, cfmeetProduct, envelope, envelopeError, operationView, path, productsReply } from "./product-fixtures";

// Approvals inbox (/dashboard/approvals): "Waiting for me" and "My requests"
// over cfmeet.governance.read; Decide / Revoke through POST /operations.

const CASE = "cfmeet:APP_REVIEW:5b0f6c1e-2a8d-4c3e-9f7a-1d2e3f4a5b6c";
const SCOPE = { market: ["NG"], organization: ["cfmeet"], zone: ["production"], tenant: ["tenant-alpha"] };
const PENDING_ID = "7d4f3a2b-1c0e-4d5f-8a9b-0c1d2e3f4a5b";
const MINE_ID = "8e5a4b3c-2d1f-4e6a-9b0c-1d2e3f4a5b6c";

function approval(over: Record<string, unknown> = {}) {
  return {
    approval_id: PENDING_ID,
    capability: "cfmeet.verification.app-review.approve",
    status: "PROPOSED",
    risk: "R4",
    expired: false,
    requester_ref: "u-alice",
    approver_ref: null,
    intent_summary: {
      capability: "cfmeet.verification.app-review.approve",
      target: { type: "cfmeet.verification_case", id: CASE },
      expected_version: 3,
      reason_code: "REVIEW_PASSED",
      case_reference: CASE,
      scope: SCOPE,
    },
    intent_digest: "sha256:" + "a".repeat(64),
    created_at: "2026-11-21T08:00:00.000Z",
    decided_at: null,
    expires_at: "2099-11-21T20:00:00.000Z",
    ...over,
  };
}

const list = (items: unknown[], collection: string) =>
  envelope({ module: "governance", capability_id: "cfmeet.governance.read", collection_id: collection, kind: "LIST", data: { items }, continuation: null, has_more: false });

const BASE = "/api/products/cfmeet/resources/cfmeet.governance.read";

function setup(api: Parameters<typeof defaultMocks>[0], pending: unknown[] = [approval()], mine: unknown[] = []) {
  defaultMocks(api, SUPER_USER);
  api.on("GET", "/api/products", productsReply([cfmeetProduct]));
  api.on("GET", "/api/products/cfmeet/capabilities", envelope(cfmeetCapabilities()));
  api.on("GET", path(`${BASE}/approvals-pending`), list(pending, "approvals-pending"));
  api.on("GET", path(`${BASE}/approvals-mine`), list(mine, "approvals-mine"));
  api.on("GET", new RegExp(`^${BASE.replace(/\./g, "\\.")}/approvals/([0-9a-f-]+)$`), (_req, _url, m) => {
    const all = [...pending, ...mine] as { approval_id: string }[];
    const found = all.find((a) => a.approval_id === m[1]);
    return found ? envelope({ kind: "DETAIL", data: found, continuation: null }) : envelopeError(404, "NOT_FOUND", "APPROVAL_NOT_FOUND");
  });
}

test("inbox tabs: waiting for me and my requests, with the approval's intent", async ({ page, api }) => {
  await signIn(page, SUPER_USER);
  setup(api, [approval(), approval({ approval_id: "9f6b5c4d-3e2a-4f7b-8c1d-2e3f4a5b6c7d", expired: true })], [
    approval({ approval_id: MINE_ID, requester_ref: "u-super", status: "APPROVED", approver_ref: "u-rita", decided_at: "2026-11-21T08:30:00.000Z" }),
  ]);
  await gotoWithEntitlements(page, "/dashboard/approvals");

  await expect(page.getByRole("heading", { name: "Approvals", exact: true })).toBeVisible();
  const waiting = page.getByRole("tab", { name: "Waiting for me" });
  await expect(waiting).toHaveAttribute("aria-selected", "true");
  const card = page.getByRole("button", { name: `Open approval for cfmeet.verification.app-review.approve on ${CASE}` }).first();
  await expect(card).toBeVisible();
  await expect(card).toContainText("Risk R4");
  await expect(card).toContainText("Waiting for decision");
  await expect(card).toContainText("REVIEW_PASSED");
  await expect(card).toContainText("market: NG · organization: cfmeet · zone: production · tenant: tenant-alpha");
  await expect(card).toContainText("requested by u-alice");
  await expect(card).toContainText("Expires");
  await expect(page.getByText("Expired", { exact: true }).first()).toBeVisible();

  const pendingCall = api.callsTo("GET", path(`${BASE}/approvals-pending`))[0];
  expect(pendingCall.query).toMatchObject({ market: "NG", organization: "cfmeet", purpose: "verification-review", limit: "25" });
  expect(pendingCall.query.zone).toBeUndefined();

  await page.getByRole("tab", { name: "My requests" }).click();
  await expect(page.getByRole("tab", { name: "My requests" })).toHaveAttribute("aria-selected", "true");
  const mine = page.getByRole("button", { name: /Open approval for/ });
  await expect(mine).toHaveCount(1);
  await expect(mine).toContainText("requested by You");
  await expect(mine).toContainText("Approved");
  await expect(mine).toContainText("Decided by");
  await expect(page).toHaveURL(/tab=mine/);

  // Own approved request: no decide, no self-revoke; a link back to the case.
  await mine.click();
  await expect(page.getByRole("region", { name: "Approval details" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Submit decision" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Revoke approval|Withdraw request/ })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Open the case" })).toHaveAttribute("href", `/dashboard/verification?product=cfmeet&case=${encodeURIComponent(CASE)}`);
  await noHorizontalScroll(page);
});

test("decide with MFA step-up resends the same command once", async ({ page, api }) => {
  await signIn(page, SUPER_USER);
  setup(api);
  const bodies: Record<string, unknown>[] = [];
  api.on("POST", "/api/products/cfmeet/operations", (req) => {
    const body = req.postDataJSON() as Record<string, unknown>;
    bodies.push(body);
    if (bodies.length === 1) return envelopeError(403, "FORBIDDEN", "RECENT_MFA_REQUIRED");
    return envelope(operationView(body.command_id as string, "cfmeet.governance.approval.decide", "SUCCEEDED", {
      source_status: "APPROVED",
      evidence: { approval_id: PENDING_ID, status: "APPROVED", expires_at: "2099-11-21T20:00:00.000Z" },
      approval: { ...approval(), status: "APPROVED", approver_ref: "u-super" },
    }));
  });
  api.on("POST", "/api/auth/mfa/step-up", ok({ verifiedAt: "2026-11-21T09:00:00.000Z" }));
  await gotoWithEntitlements(page, "/dashboard/approvals");

  await page.getByRole("button", { name: /Open approval for/ }).click();
  const decide = page.getByRole("form", { name: "Decide" });
  await expect(decide).toBeVisible();
  await expect(page.getByRole("region", { name: "Approval details" })).toContainText("sha256:" + "a".repeat(64));
  await decide.getByLabel("Decision reason").selectOption("EVIDENCE_REVIEWED");
  await decide.getByRole("button", { name: "Submit decision" }).click();

  // MFA refusal -> step-up dialog -> the identical command once more.
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Authentication code")).toBeVisible();
  await dialog.getByLabel("Authentication code").fill("123456");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText("Approved. The requester can now run the action once.")).toBeVisible();

  expect(api.callsTo("POST", "/api/auth/mfa/step-up")[0].body).toEqual({ code: "123456" });
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toEqual(bodies[0]);
  expect(bodies[0]).toMatchObject({
    capability_id: "cfmeet.governance.approval.decide",
    target: { type: "cfmeet.approval", id: PENDING_ID, expected_version: null },
    params: { approval_id: PENDING_ID, decision: "APPROVE" },
    reason_code: "EVIDENCE_REVIEWED",
    case_reference: CASE,
    scope: SCOPE,
  });
  expect(bodies[0].idempotency_key).toBe(`hq.${bodies[0].command_id}`);
});

test("a refused decision shows the server's reason", async ({ page, api }) => {
  await signIn(page, SUPER_USER);
  setup(api);
  api.on("POST", "/api/products/cfmeet/operations", (req) =>
    envelopeError(409, "CONFLICT", "APPROVAL_ALREADY_DECIDED", (req.postDataJSON() as { command_id: string }).command_id));
  await gotoWithEntitlements(page, "/dashboard/approvals");

  await page.getByRole("button", { name: /Open approval for/ }).click();
  const decide = page.getByRole("form", { name: "Decide" });
  await decide.getByText("Reject").click();
  await decide.getByLabel("Decision reason").selectOption("WRONG_TARGET");
  await decide.getByRole("button", { name: "Submit decision" }).click();

  const alert = page.getByRole("alert").filter({ hasText: "Refused" });
  await expect(alert).toContainText("Refused: Someone already decided this approval.");
  await expect(alert).toContainText("Reason: CONFLICT / APPROVAL_ALREADY_DECIDED");
  const body = api.callsTo("POST", "/api/products/cfmeet/operations")[0].body as { params: unknown; reason_code: string };
  expect(body.params).toEqual({ approval_id: PENDING_ID, decision: "REJECT" });
  expect(body.reason_code).toBe("WRONG_TARGET");
  // One click, one command: nothing is resent.
  expect(api.callsTo("POST", "/api/products/cfmeet/operations")).toHaveLength(1);
});

test("own proposed request can be withdrawn but never decided", async ({ page, api }) => {
  await signIn(page, SUPER_USER);
  const own = approval({ approval_id: MINE_ID, requester_ref: "u-super" });
  setup(api, [], [own]);
  api.on("POST", "/api/products/cfmeet/operations", (req) => {
    const body = req.postDataJSON() as { command_id: string };
    return envelope(operationView(body.command_id, "cfmeet.governance.approval.revoke", "SUCCEEDED", { approval: { ...own, status: "REVOKED" } }));
  });
  await gotoWithEntitlements(page, "/dashboard/approvals?tab=mine");

  await expect(page.getByRole("tab", { name: "My requests" })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: /Open approval for/ }).click();
  await expect(page.getByText("You requested this approval. A different staff member who holds its whole scope must decide it.")).toBeVisible();
  await expect(page.getByRole("form", { name: "Decide" })).toHaveCount(0);
  await page.getByRole("button", { name: "Withdraw request" }).click();
  await expect(page.getByText("Revoked. The approval can no longer be used.")).toBeVisible();
  expect(api.callsTo("POST", "/api/products/cfmeet/operations")[0].body).toMatchObject({
    capability_id: "cfmeet.governance.approval.revoke",
    params: { approval_id: MINE_ID, reason_code: "NO_LONGER_NEEDED" },
  });
});

test("a blocked approvals capability is shown as blocked, not empty", async ({ page, api }) => {
  await signIn(page, SUPER_USER);
  setup(api);
  api.on("GET", "/api/products/cfmeet/capabilities", envelope(cfmeetCapabilities({ governance: "DISABLED" })));
  await gotoWithEntitlements(page, "/dashboard/approvals");
  await expect(page.getByRole("alert", { name: "Approvals blocked" })).toContainText("cfmeet.governance.read");
  expect(api.callsTo("GET", path(`${BASE}/approvals-pending`))).toHaveLength(0);
});
