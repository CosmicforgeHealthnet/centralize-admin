"use client";

import Link from "next/link";
import { useEffect, useId, useRef } from "react";
import { ChevronDown, PanelsTopLeft, type LucideIcon } from "lucide-react";

export interface SectionItem { value: string; label: string; href?: string; icon?: LucideIcon }
export interface SectionGroup { label: string; items: SectionItem[] }

export default function SectionNavigation({ label, groups, value, onChange, sidebar = false }: {
  label: string; groups: SectionGroup[]; value: string; onChange: (value: string) => void; sidebar?: boolean;
}) {
  const id = useId();
  const row = useRef<HTMLDivElement>(null);
  const items = groups.flatMap(group => group.items);
  const active = items.find(item => item.value === value);
  const ActiveIcon = active?.icon ?? PanelsTopLeft;
  useEffect(() => {
    const container = row.current;
    const selected = container?.querySelector<HTMLElement>('[aria-current="page"]');
    if (container && selected && !sidebar) container.scrollLeft = Math.max(0, selected.getBoundingClientRect().left - container.getBoundingClientRect().left + container.scrollLeft - 16);
  }, [value, sidebar]);
  const itemClass = (selected: boolean) => sidebar
    ? `flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[13px] leading-5 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${selected ? "bg-secondary font-semibold text-secondary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`
    : `inline-flex min-h-12 shrink-0 items-center whitespace-nowrap border-b-2 px-4 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-primary ${selected ? "border-primary font-semibold text-secondary-foreground" : "border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground"}`;
  return <nav aria-label={label} className={sidebar ? "min-w-0 min-[1200px]:sticky min-[1200px]:top-4 min-[1200px]:w-[216px] min-[1200px]:shrink-0" : "min-w-0"}>
    <div className={sidebar ? "min-[1200px]:hidden" : "lg:hidden"}>
      <label htmlFor={id} className="mb-1.5 block text-xs font-medium text-muted-foreground">{label}</label>
      <div className="relative rounded-xl border border-border bg-card shadow-sm focus-within:ring-2 focus-within:ring-primary/30">
        <ActiveIcon aria-hidden="true" className="pointer-events-none absolute left-3.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-secondary-foreground" />
        <select id={id} value={value} onChange={event => onChange(event.target.value)} className="min-h-12 w-full min-w-0 appearance-none rounded-xl bg-transparent py-3 pl-11 pr-10 text-sm font-semibold text-foreground outline-none">
          {groups.length > 1 ? groups.map(group => <optgroup key={group.label} label={group.label}>{group.items.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</optgroup>) : items.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
        <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      </div>
    </div>
    <div ref={row} className={sidebar ? "hidden space-y-5 rounded-xl border border-border bg-card p-3 min-[1200px]:block" : "relative hidden min-w-0 overflow-x-auto border-b border-border lg:flex"}>
      {groups.map(group => <div key={group.label} className={sidebar ? "space-y-1" : "flex shrink-0"}>
        {sidebar && groups.length > 1 && <p className="px-3 pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{group.label}</p>}
        {group.items.map(item => {
          const Icon = item.icon;
          const content = <>{sidebar && Icon && <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />}<span>{item.label}</span></>;
          return item.href ? <Link key={item.value} href={item.href} aria-current={value === item.value ? "page" : undefined} className={itemClass(value === item.value)}>{content}</Link> : <button key={item.value} type="button" onClick={() => onChange(item.value)} aria-current={value === item.value ? "page" : undefined} className={itemClass(value === item.value)}>{content}</button>;
        })}
      </div>)}
    </div>
  </nav>;
}
