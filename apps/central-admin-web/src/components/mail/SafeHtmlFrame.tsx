"use client";

import { useMemo, useRef } from "react";

const FRAME_STYLE = `<style>
  html,body{margin:0;padding:0;font-family:Poppins,Arial,sans-serif;font-size:13px;color:#111827;word-wrap:break-word;overflow-wrap:anywhere}
  img{max-width:100%;height:auto}
  table{max-width:100%}
  a{color:#272EA7}
  blockquote{margin:0 0 0 .8ex;border-left:2px solid #ddd;padding-left:1ex;color:#555}
</style>`;

/**
 * Displays HTML that was already sanitized by the server inside a fully
 * sandboxed iframe: no scripts, no same-origin access, no forms, no popups.
 * Links cannot navigate the parent.
 */
export default function SafeHtmlFrame({ html, title, minHeight = 80 }: { html: string; title: string; minHeight?: number }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https: cid:; style-src 'unsafe-inline';"><base target="_blank">${FRAME_STYLE}</head><body>${html}</body></html>`;

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
      className="w-full rounded border border-border bg-white"
    />
  );
}
