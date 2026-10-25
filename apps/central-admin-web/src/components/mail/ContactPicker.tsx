"use client";

import { useEffect, useId, useRef, useState } from "react";
import { X } from "lucide-react";
import { suggestContacts } from "@/lib/mail.service";
import { isValidEmail, partyLabel } from "./mail-utils";
import type { Party } from "@/types/mail.types";

export default function ContactPicker({
  label,
  value,
  onChange,
  disabled,
  autoFocus,
}: {
  label: string;
  value: Party[];
  onChange: (next: Party[]) => void;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const id = useId();
  const listId = `${id}-suggestions`;
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [suggestions, setSuggestions] = useState<Party[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [invalid, setInvalid] = useState<string | null>(null);

  useEffect(() => {
    const q = text.trim();
    if (q.length < 2) return;
    let cancelled = false;
    const handle = setTimeout(async () => {
      try {
        const res = await suggestContacts(q);
        if (!cancelled) {
          setSuggestions(res.filter((p) => !value.some((v) => v.address === p.address)).slice(0, 8));
          setActiveIndex(-1);
        }
      } catch {
        if (!cancelled) setSuggestions([]);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [text, value]);

  const visible = text.trim().length < 2 ? [] : suggestions;

  const add = (party: Party) => {
    const address = party.address.trim().toLowerCase();
    if (!isValidEmail(address)) {
      setInvalid(`"${party.address}" is not a valid email address.`);
      return;
    }
    setInvalid(null);
    if (!value.some((v) => v.address.toLowerCase() === address)) onChange([...value, { address, name: party.name }]);
    setText("");
    setSuggestions([]);
  };

  const commitText = () => {
    const parts = text.split(/[,;\s]+/).filter(Boolean);
    if (!parts.length) return;
    for (const p of parts) add({ address: p, name: null });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" && visible.length) {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, visible.length - 1));
    } else if (e.key === "ArrowUp" && visible.length) {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" || e.key === "," || e.key === ";" || e.key === "Tab") {
      if (activeIndex >= 0 && visible[activeIndex]) {
        e.preventDefault();
        add(visible[activeIndex]);
      } else if (text.trim()) {
        if (e.key !== "Tab") e.preventDefault();
        commitText();
      }
    } else if (e.key === "Backspace" && !text && value.length) {
      onChange(value.slice(0, -1));
    } else if (e.key === "Escape") {
      setSuggestions([]);
    }
  };

  return (
    <div className="relative">
      <div className="flex flex-wrap items-center gap-1 border-b border-border px-1 py-1.5" onClick={() => inputRef.current?.focus()}>
        <label htmlFor={id} className="w-10 shrink-0 text-[12px] text-muted-foreground">
          {label}
        </label>
        {value.map((p) => (
          <span key={p.address} className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px]">
            {partyLabel(p)}
            {!disabled && (
              <button type="button" aria-label={`Remove ${p.address}`} onClick={() => onChange(value.filter((v) => v.address !== p.address))}>
                <X className="h-3 w-3" />
              </button>
            )}
          </span>
        ))}
        <input
          id={id}
          ref={inputRef}
          value={text}
          disabled={disabled}
          autoFocus={autoFocus}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => setTimeout(() => text.trim() && commitText(), 150)}
          role="combobox"
          aria-expanded={visible.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
          className="min-w-[120px] flex-1 bg-transparent text-[12px] outline-none"
        />
      </div>
      {invalid && <p role="alert" className="px-1 pt-0.5 text-[11px] text-red-600">{invalid}</p>}
      {visible.length > 0 && (
        <ul id={listId} role="listbox" className="absolute left-10 right-0 z-20 mt-1 max-h-56 overflow-auto rounded-md border border-border bg-card shadow-lg">
          {visible.map((s, i) => (
            <li
              key={s.address}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === activeIndex}
              onMouseDown={(e) => {
                e.preventDefault();
                add(s);
              }}
              className={`cursor-pointer px-3 py-1.5 text-[12px] ${i === activeIndex ? "bg-primary/10" : "hover:bg-muted"}`}
            >
              {partyLabel(s)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
