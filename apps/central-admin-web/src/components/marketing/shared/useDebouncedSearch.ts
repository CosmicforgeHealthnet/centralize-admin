"use client";
import { useEffect, useRef } from "react";

export function useDebouncedSearch(value: string, search: () => void) {
  const callback = useRef(search);
  const previous = useRef(value);
  useEffect(() => { callback.current = search; }, [search]);
  useEffect(() => {
    if (value === previous.current) return;
    const timer = window.setTimeout(() => { previous.current = value; callback.current(); }, 300);
    return () => window.clearTimeout(timer);
  }, [value]);
}
