"use client";

import { Search } from "lucide-react";
import type { InputHTMLAttributes } from "react";

export default function SearchField({ className = "", "aria-label": label, placeholder = "Search", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <div className="marketing-search relative w-full min-w-0">
    <Search size={17} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
    <input {...props} type="search" aria-label={label ?? placeholder} placeholder={placeholder} className={
      "min-h-11 w-full min-w-0 rounded-lg border border-border bg-background py-2.5 pl-10 pr-3 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:text-sm " + className
    } />
  </div>;
}
