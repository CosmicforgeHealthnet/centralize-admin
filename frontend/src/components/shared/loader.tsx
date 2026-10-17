import * as React from "react";
import { cn } from "@/lib/utils";

export type LoaderProps = React.HTMLAttributes<HTMLDivElement>;

export function Loader({ className, style, ...props }: LoaderProps) {
  return (
    <div
      role="status"
      style={{
        width: "50px",
        height: "50px",
        top: "20px",
        left: "20px",
        animationDelay: "1ms",
        animationTimingFunction: "linear",
        animationDuration: "50ms",
        ...style,
      }}
      className={cn("absolute animate-spin text-primary", className)}
      {...props}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="size-full"
      >
        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
      </svg>
      <span className="sr-only">Loading...</span>
    </div>
  );
}
