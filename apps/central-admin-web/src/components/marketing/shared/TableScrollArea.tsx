"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/** Keep wide results usable without widening the dashboard or hiding columns. */
export default function TableScrollArea({ children, className = "", label = "Results table" }: { children: ReactNode; className?: string; label?: string }) {
  const viewport = useRef<HTMLDivElement>(null);
  const hint = useId();
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => setOverflows(element.scrollWidth > element.clientWidth + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, [children]);
  return <div className={"min-w-0 max-w-full " + className}>
    {overflows && <p id={hint} className="border-b border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">Scroll horizontally to see all columns.</p>}
    <div ref={viewport} role="region" aria-label={label} aria-describedby={overflows ? hint : undefined} tabIndex={overflows ? 0 : undefined} className="marketing-table-scroll max-w-full overflow-x-auto overscroll-x-contain focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring">
      {children}
    </div>
  </div>;
}
