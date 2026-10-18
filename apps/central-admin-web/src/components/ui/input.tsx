"use client";

import * as React from "react";
import { Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  const [showPassword, setShowPassword] = React.useState(false);
  const isPassword = type === "password";

  return (
    <div className="relative w-full">
      <input
        type={isPassword ? (showPassword ? "text" : "password") : type}
        data-slot="input"
        className={cn(
          "w-full h-[54px] rounded-[10px] border border-input bg-white dark:bg-[#1a1a1a] px-[12px] py-[12px] text-base text-foreground shadow-none transition-colors outline-none",
          "placeholder:text-input-placeholder",
          "focus-visible:border-[1.5px] focus-visible:border-primary",
          "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
          "file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground",
          "md:text-sm",
          "aria-invalid:border-destructive",
          isPassword && "pr-12",
          className,
        )}
        {...props}
      />
      {isPassword && (
        <button
          type="button"
          onClick={() => setShowPassword((prev) => !prev)}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
          aria-label={showPassword ? "Hide password" : "Show password"}
          tabIndex={-1}
        >
          {showPassword ? <EyeOff className="size-5" /> : <Eye className="size-5" />}
        </button>
      )}
    </div>
  );
}

export { Input };