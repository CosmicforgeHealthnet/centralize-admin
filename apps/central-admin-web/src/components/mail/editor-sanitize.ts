// Client-side allowlist sanitizer used before placing HTML into the compose
// editor (a contentEditable element in the app origin). The server sanitizes
// all stored/rendered HTML as well; this is defence in depth so quoted replies
// or signatures can never execute script in the Admin origin.

const ALLOWED_TAGS = new Set([
  "a", "b", "blockquote", "br", "code", "div", "em", "h1", "h2", "h3", "hr", "i", "li", "ol",
  "p", "pre", "s", "span", "strong", "table", "tbody", "td", "th", "thead", "tr", "u", "ul", "img",
]);
const DROP_WITH_CONTENT = new Set(["script", "style", "iframe", "object", "embed", "noscript", "template", "svg", "math", "form", "link", "meta", "base"]);
const SAFE_HREF = /^(https?:|mailto:)/i;

function cleanNode(node: Node, out: Node, doc: Document) {
  node.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      out.appendChild(doc.createTextNode(child.textContent ?? ""));
      return;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) return;
    const el = child as Element;
    const tag = el.tagName.toLowerCase();
    if (DROP_WITH_CONTENT.has(tag)) return;
    if (!ALLOWED_TAGS.has(tag)) {
      cleanNode(el, out, doc); // unwrap
      return;
    }
    const copy = doc.createElement(tag);
    if (tag === "a") {
      const href = el.getAttribute("href") ?? "";
      if (SAFE_HREF.test(href.trim())) {
        copy.setAttribute("href", href.trim());
        copy.setAttribute("rel", "noopener noreferrer nofollow");
        copy.setAttribute("target", "_blank");
      }
    }
    if (tag === "img") {
      // Only embedded data images; remote images would leak read receipts.
      const src = el.getAttribute("src") ?? "";
      if (!/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(src)) return;
      copy.setAttribute("src", src);
      copy.setAttribute("alt", el.getAttribute("alt") ?? "");
    }
    cleanNode(el, copy, doc);
    out.appendChild(copy);
  });
}

export function sanitizeForEditor(html: string): string {
  if (typeof window === "undefined" || !html) return "";
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const target = document.implementation.createHTMLDocument("");
  const container = target.createElement("div");
  cleanNode(parsed.body, container, target);
  return container.innerHTML;
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}
