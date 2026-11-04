"use client";

import { useMemo, useRef, useSyncExternalStore } from "react";

function subscribeTheme(callback: () => void) {
  const observer = new MutationObserver(callback);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}
const getDarkTheme = () => document.documentElement.classList.contains("dark");
const getServerTheme = () => false;

const frameStyle = (dark: boolean) => `<style>
  html,body{color-scheme:${dark ? "dark" : "light"};background:${dark ? "#1b1c1c" : "#fff"};margin:0;padding:0;font-family:Poppins,Arial,sans-serif;font-size:13px;color:${dark ? "#f3f4f6" : "#111827"};word-wrap:break-word;overflow-wrap:anywhere}
  img{max-width:100%;height:auto}
  table{max-width:100%}
  a{color:${dark ? "#a4a9ff" : "#272EA7"}}
  blockquote{margin:0 0 0 .8ex;border-left:2px solid ${dark ? "#606274" : "#ddd"};padding-left:1ex;color:${dark ? "#c0c2cf" : "#555"}}
  a[data-suspicious]{background:#fef3c7;outline:1px dashed #d97706;color:#92400e}
  a[data-suspicious]::after{content:" \\26A0  check link";font-size:10px;font-weight:600;color:#b45309}
</style>`;

/**
 * Displays HTML that was already sanitized by the server inside a fully
 * sandboxed iframe: no scripts, no same-origin access, no forms, no popups.
 * Links cannot navigate the parent. Remote (https:) images load only when the
 * user explicitly allowed them for this message (allowRemoteImages); otherwise
 * the CSP allows data: images only, as a second line of defence against
 * tracking pixels that slip past the sanitizer.
 */
export default function SafeHtmlFrame({
  html,
  title,
  minHeight = 80,
  allowRemoteImages = false,
}: {
  html: string;
  title: string;
  minHeight?: number;
  allowRemoteImages?: boolean;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const dark = useSyncExternalStore(subscribeTheme, getDarkTheme, getServerTheme);
  const imgSrc = allowRemoteImages ? "data: https:" : "data:";
  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${imgSrc}; style-src 'unsafe-inline'; font-src 'none'; form-action 'none';"><base target="_blank">${frameStyle(dark)}</head><body>${html}</body></html>`;

  // Sandbox without allow-same-origin blocks reading contentDocument, so size
  // by a content estimate and let the user scroll inside the frame.
  const height = useMemo(() => {
    const lines = html.split(/<br|<p|<div|<tr|<li/i).length;
    return Math.min(Math.max(minHeight, lines * 22 + 40), 900);
  }, [html, minHeight]);

  return (
    <iframe
      ref={ref}
      title={title}
      // No allow-scripts / allow-same-origin: content can never run code.
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      srcDoc={doc}
      style={{ height }}
      className="w-full rounded border border-border bg-card"
    />
  );
}
