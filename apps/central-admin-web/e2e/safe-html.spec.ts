import { test, expect, signIn, defaultMocks, gotoWithEntitlements, mailbox, thread, message, ok, ALICE } from "./fixtures";

const M = "/api/mail/v1";
const TRACKER = "https://tracker.example/pixel.gif";

// Defense in depth: the server sanitizes, but even if hostile markup reached the
// browser the sandboxed frame must not execute it.
const HOSTILE = `<p>Invoice ready.</p>
<script>window.top.__pwned = "script"; alert("xss")</script>
<img src="x" onerror="window.top.__pwned='onerror'; alert('xss')">
<a href="javascript:window.top.__pwned='link'">click</a>`;

test.describe("Message HTML is rendered safely", () => {
  test("hostile markup does not execute and remote images stay blocked until the reader opts in", async ({ page, api }) => {
    const dialogs: string[] = [];
    page.on("dialog", (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });
    await signIn(page, ALICE);
    defaultMocks(api, ALICE);
    api.on("GET", `${M}/mailboxes/mb-alice`, ok({ ...mailbox(), senderIdentities: [], signatureHtml: null }));
    api.on("GET", `${M}/threads/th-1`, ok(thread({ isRead: true })));
    api.on("GET", `${M}/threads/th-1/messages`, (_req, url) =>
      url.searchParams.get("remoteImages") === "allow"
        ? ok([message({ html: `${HOSTILE}<img src="${TRACKER}" alt="logo">`, remoteImagesBlocked: 0 })])
        : ok([message({ html: HOSTILE, remoteImagesBlocked: 1 })]),
    );

    await gotoWithEntitlements(page, "/dashboard/mail/mb-alice/thread/th-1");
    const frame = page.locator("iframe").first();
    await expect(frame).toBeVisible();
    const sandbox = (await frame.getAttribute("sandbox")) ?? "";
    expect(sandbox).not.toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");
    expect(await frame.getAttribute("srcdoc")).toContain("Content-Security-Policy");
    await expect(page.frameLocator("iframe").first().getByText("Invoice ready.")).toBeVisible();

    const banner = page.getByText(/1 remote image was blocked/);
    await expect(banner).toBeVisible();
    await page.waitForTimeout(500);
    expect(api.blockedExternal.filter((u) => u.startsWith(TRACKER)), "no remote image fetched while blocked").toEqual([]);

    await page.getByRole("button", { name: "Show images" }).click();
    await expect.poll(() => api.callsTo("GET", `${M}/threads/th-1/messages`).some((c) => c.query.remoteImages === "allow")).toBe(true);
    expect(api.callsTo("GET", `${M}/threads/th-1/messages`)[0].query.remoteImages, "first load blocks remote images").toBe("block");
    await expect(banner).toHaveCount(0);
    // Only after opting in does the frame try to load the remote image (aborted offline by the harness).
    await expect.poll(() => api.blockedExternal.some((u) => u.startsWith(TRACKER))).toBe(true);
    await page.frameLocator("iframe").first().getByText("click").click({ force: true }).catch(() => undefined);

    await page.waitForTimeout(500);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: string }).__pwned)).toBeUndefined();
    expect(dialogs).toEqual([]);
  });
});
