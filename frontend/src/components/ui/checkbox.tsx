"use client";

import * as React from "react";
import { Checkbox as CheckboxPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

const CustomCheck = ({ className }: { className?: string }) => (
  <svg
    width="12"
    height="10"
    viewBox="0 0 12 10"
    fill="none"
    className={className}
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d="M1 5L4.5 8.5L11 1"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const CustomMinus = ({ className }: { className?: string }) => (
  <svg
    width="12"
    height="10"
    viewBox="0 0 12 10"
    fill="none"
    className={className}
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d="M2 5H10"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "group peer size-5 shrink-0 rounded-[4px] border-[1.5px] border-primary transition-all outline-none",
        "hover:bg-checkbox-hover",
        "focus-visible:ring-[3px] focus-visible:ring-checkbox-ring focus-visible:border-primary",
        "disabled:cursor-not-allowed disabled:border-muted-foreground disabled:opacity-50",
        "data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground",
        "data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground",
        "dark:data-[state=checked]:bg-primary dark:data-[state=indeterminate]:bg-primary",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="flex items-center justify-center text-current transition-none"
      >
        <CustomCheck className="hidden group-data-[state=checked]:block" />
        <CustomMinus className="hidden group-data-[state=indeterminate]:block" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
