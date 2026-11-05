import { test, expect, signIn, defaultMocks, gotoWithEntitlements, entitlements, mailbox, draft, ok, fail, ALICE, ALICE_IDENTITY, type MockApi } from "./fixtures";
import type { Page } from "@playwright/test";
import crypto from "node:crypto";

const M = "/api/mail/v1";
const MiB = 1024 * 1024;
const LIMITS = { attachmentMaxBytes: 10 * MiB, messageMaxBytes: 25 * MiB, maxAttachmentsPerMessage: 3 };
const PDF_NAME = "Karryam Vendor Partner Pitch (2).pdf";

/** Structurally valid 14-page PDF of an exact size (random, incompressible padding stream). */
function makePdf(bytes: number, pages = 14): Buffer {
  const kids = Array.from({ length: pages }, (_, i) => `${5 + i * 2} 0 R`).join(" ");
  const body = (id: number, content: Buffer | string) => Buffer.concat([Buffer.from(`${id} 0 obj\n`), Buffer.isBuffer(content) ? content : Buffer.from(content), Buffer.from("\nendobj\n")]);
  const build = (pad: number) => {
    const parts: Buffer[] = [Buffer.from("%PDF-1.4\n")];
    const offsets: number[] = [0];
    let pos = parts[0].length;
    const add = (id: number, content: Buffer | string) => { offsets[id] = pos; const b = body(id, content); parts.push(b); pos += b.length; };
    add(1, "<< /Type /Catalog /Pages 2 0 R >>");
    add(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`);
    add(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
    add(4, Buffer.concat([Buffer.from(`<< /Length ${pad} >>\nstream\n`), Buffer.alloc(pad, 0x41), Buffer.from("\nendstream")]));
    for (let i = 0; i < pages; i += 1) {
      const text = `BT /F1 18 Tf 72 720 Td (page ${i + 1}) Tj ET`;
      add(5 + i * 2, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${6 + i * 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`);
      add(6 + i * 2, `<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
    }
    const total = 5 + pages * 2;
    let xref = `xref\n0 ${total}\n0000000000 65535 f \n`;
    for (let id = 1; id < total; id += 1) xref += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
    xref += `trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`;
    parts.push(Buffer.from(xref));
    return Buffer.concat(parts);
  };
  let pad = Math.max(0, bytes - build(0).length);
  let pdf = build(pad);
  for (let i = 0; i < 4 && pdf.length !== bytes; i += 1) {
    pad = Math.max(0, pad + (bytes - pdf.length));
    pdf = build(pad);
  }
  return pdf;
}

function attachment(overrides: Record<string, unknown> = {}) {
  return { id: crypto.randomUUID(), filename: PDF_NAME, contentType: "application/pdf", sizeBytes: 3 * MiB, scanStatus: "CLEAN", downloadable: true, createdAt: new Date().toISOString(), ...overrides };
}

function setup(api: MockApi) {
  defaultMocks(api, ALICE, entitlements({ limits: LIMITS }));
  api.on("GET", `${M}/mailboxes/mb-alice`, ok({ ...mailbox(), senderIdentities: [ALICE_IDENTITY], signatureHtml: null }));
  api.on("POST", `${M}/mailboxes/mb-alice/drafts`, ok(draft()));
  api.on("PATCH", `${M}/drafts/dr-1`, (req) => ok(draft({ ...(req.postDataJSON() as object), revision: 2 })));
}

async function openCompose(page: Page) {
  await gotoWithEntitlements(page, "/dashboard/mail/compose?mailboxId=mb-alice");
  await expect(page.getByRole("form", { name: "Compose message" })).toBeVisible();
}

// The Next.js route announcer is also role=alert; target only the app's own alert.
const alertBox = (page: Page) => page.locator('[role="alert"]:not(#__next-route-announcer__)');

const attach = (page: Page, name: string, buffer: Buffer, mimeType = "application/pdf") =>
  page.getByLabel("Attach files", { exact: true }).setInputFiles({ name, mimeType, buffer });

test.describe("Compose attachments: valid uploads, honest limits, distinguishable failures", () => {
  test("a real 3 MiB 14-page PDF uploads with a browser-generated multipart boundary, then remove and re-attach", async ({ page, api }) => {
    await signIn(page, ALICE);
    setup(api);
    const seen: { contentType: string; size: number; hasPdf: boolean; hasBoundary: boolean }[] = [];
    let current: ReturnType<typeof attachment> | null = null;
    api.on("POST", `${M}/drafts/dr-1/attachments`, (req) => {
      const contentType = req.headers()["content-type"] ?? "";
      const data = req.postDataBuffer() ?? Buffer.alloc(0);
      const boundary = /boundary=(.+)$/.exec(contentType)?.[1] ?? "";
      seen.push({ contentType, size: data.length, hasPdf: data.includes(Buffer.from("%PDF-1.4")), hasBoundary: boundary.length > 8 && data.includes(Buffer.from(`--${boundary}`)) });
      current = attachment();
      return { status: 201, body: { success: true, data: current } };
    });
    api.on("DELETE", new RegExp(`^${M}/drafts/dr-1/attachments/[^/]+$`), () => ok({ removed: true }));
    await openCompose(page);

    const pdf = makePdf(3 * MiB);
    expect(pdf.length).toBe(3 * MiB);
    await attach(page, PDF_NAME, pdf);
    await expect(page.getByText(PDF_NAME)).toBeVisible();
    expect(seen).toHaveLength(1);
    expect(seen[0].contentType).toMatch(/^multipart\/form-data; boundary=\S{8,}/);
    expect(seen[0].hasBoundary, "body is framed with the header's boundary").toBe(true);
    expect(seen[0].hasPdf).toBe(true);
    expect(seen[0].size).toBeGreaterThan(3 * MiB);
    await expect(alertBox(page)).toHaveCount(0);

    await page.getByRole("button", { name: new RegExp(`Remove.*${PDF_NAME.replace(/[()]/g, "\\$&")}`) }).click();
    await expect(page.getByText(PDF_NAME)).toHaveCount(0);
    expect(api.callsTo("DELETE", new RegExp("/attachments/"))).toHaveLength(1);
    await attach(page, PDF_NAME, pdf);
    await expect(page.getByText(PDF_NAME)).toBeVisible();
    expect(seen).toHaveLength(2);
  });

  test("a file over the API-published per-file limit is stopped before upload with the real limit in the message", async ({ page, api }) => {
    await signIn(page, ALICE);
    setup(api);
    api.on("POST", `${M}/drafts/dr-1/attachments`, ok({}));
    await openCompose(page);
    await attach(page, "huge.pdf", Buffer.alloc(11 * MiB, 1));
    await expect(alertBox(page).filter({ hasText: "huge.pdf is larger than the 10 MB per-file limit" })).toBeVisible();
    expect(api.callsTo("POST", `${M}/drafts/dr-1/attachments`)).toHaveLength(0);
  });

  test("a reverse-proxy 413 (HTML, not the API envelope) is reported as a gateway rejection, distinct from the API's own limit", async ({ page, api }) => {
    await signIn(page, ALICE);
    setup(api);
    api.on("POST", `${M}/drafts/dr-1/attachments`, { status: 413, contentType: "text/html", body: "<html><head><title>413 Request Entity Too Large</title></head><body>nginx</body></html>" });
    await openCompose(page);
    await attach(page, PDF_NAME, makePdf(3 * MiB));
    const alert = alertBox(page);
    await expect(alert).toContainText("upload gateway rejected");
    await expect(alert).not.toContainText("per-file limit");
    await expect(alert).not.toContainText("nginx");
    await expect(page.getByText(PDF_NAME)).toHaveCount(1); // only inside the error text, not as an attachment chip
    await expect(page.getByRole("list", { name: /attachments/i })).toHaveCount(0);
  });

  test("API errors are distinguishable and carry the support reference", async ({ page, api }) => {
    await signIn(page, ALICE);
    setup(api);
    const replies: Array<{ name: string; reply: { status: number; body: Record<string, unknown> }; expect: RegExp }> = [
      { name: "toolarge.pdf", reply: { status: 413, body: { success: false, code: "MAIL_ATTACHMENT_TOO_LARGE", message: "x", errors: [{ code: "MAIL_ATTACHMENT_TOO_LARGE", maxBytes: 10 * MiB }], correlationId: "corr-413" } }, expect: /larger than the 10 MB per-file limit.*corr-413/ },
      { name: "storage.pdf", reply: { status: 503, body: { success: false, code: "MAIL_STORAGE_UNAVAILABLE", message: "x", errors: [{ code: "MAIL_STORAGE_UNAVAILABLE", retryable: true }], correlationId: "corr-503" } }, expect: /temporarily unavailable.*corr-503/ },
      { name: "agg.pdf", reply: { status: 413, body: { success: false, code: "MAIL_VALIDATION_FAILED", message: "x", errors: [{ code: "MAIL_VALIDATION_FAILED", field: "file", reason: "MESSAGE_TOO_LARGE" }], correlationId: "corr-agg" } }, expect: /message too large to send.*corr-agg/ },
      { name: "boundary.pdf", reply: { status: 400, body: { success: false, code: "MAIL_VALIDATION_FAILED", message: "x", errors: [{ code: "MAIL_VALIDATION_FAILED", field: "file", reason: "MALFORMED_MULTIPART" }], correlationId: "corr-mp" } }, expect: /malformed.*corr-mp/ },
    ];
    api.on("POST", `${M}/drafts/dr-1/attachments`, (req) => {
      const name = /filename="([^"]+)"/.exec(req.postData() ?? "")?.[1] ?? "";
      const hit = replies.find((r) => r.name === name);
      return hit ? hit.reply : fail(500, "X", "unexpected");
    });
    await openCompose(page);
    for (const r of replies) {
      await attach(page, r.name, makePdf(200 * 1024, 2));
      await expect(alertBox(page)).toContainText(r.expect);
    }
  });

  test("a scan-failed upload is shown as not sendable and Send is blocked", async ({ page, api }) => {
    await signIn(page, ALICE);
    setup(api);
    api.on("POST", `${M}/drafts/dr-1/attachments`, { status: 201, body: { success: true, data: attachment({ scanStatus: "SCANNER_UNAVAILABLE", downloadable: false }) } });
    api.on("POST", `${M}/drafts/dr-1/send`, ok({}));
    await openCompose(page);
    await attach(page, PDF_NAME, makePdf(200 * 1024, 2));
    await expect(alertBox(page)).toContainText("could not be cleared by malware scanning");
    await page.getByLabel("To", { exact: true }).fill("partner@partner.example");
    await page.getByLabel("To", { exact: true }).press("Enter");
    await page.getByLabel("Subject").fill("With scan failure");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(alertBox(page).filter({ hasText: "Remove attachments that are still scanning or were quarantined" })).toBeVisible();
    expect(api.callsTo("POST", `${M}/drafts/dr-1/send`)).toHaveLength(0);
  });

  test("one failing file in a batch does not discard the others", async ({ page, api }) => {
    await signIn(page, ALICE);
    setup(api);
    api.on("POST", `${M}/drafts/dr-1/attachments`, (req) => {
      const name = /filename="([^"]+)"/.exec(req.postData() ?? "")?.[1] ?? "";
      return name === "bad.pdf"
        ? fail(503, "MAIL_STORAGE_UNAVAILABLE", "x", [{ code: "MAIL_STORAGE_UNAVAILABLE" }])
        : { status: 201, body: { success: true, data: attachment({ filename: name }) } };
    });
    await openCompose(page);
    await page.getByLabel("Attach files", { exact: true }).setInputFiles([
      { name: "bad.pdf", mimeType: "application/pdf", buffer: makePdf(100 * 1024, 1) },
      { name: "good.pdf", mimeType: "application/pdf", buffer: makePdf(100 * 1024, 1) },
    ]);
    await expect(page.getByText("good.pdf")).toBeVisible();
    await expect(alertBox(page)).toContainText("bad.pdf");
  });

  test("attachment count limit from the API stops extra files before upload", async ({ page, api }) => {
    await signIn(page, ALICE);
    setup(api);
    api.on("POST", `${M}/drafts/dr-1/attachments`, (req) => ({ status: 201, body: { success: true, data: attachment({ filename: /filename="([^"]+)"/.exec(req.postData() ?? "")?.[1] ?? "f", sizeBytes: 1000 }) } }));
    await openCompose(page);
    await page.getByLabel("Attach files", { exact: true }).setInputFiles(Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.txt`, mimeType: "text/plain", buffer: Buffer.from("x") })));
    await expect(alertBox(page)).toContainText("at most 3 attachments");
    expect(api.callsTo("POST", `${M}/drafts/dr-1/attachments`)).toHaveLength(3);
  });
});
