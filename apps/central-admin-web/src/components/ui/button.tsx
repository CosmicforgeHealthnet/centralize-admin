import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-subheading whitespace-nowrap transition-all outline-none cursor-pointer disabled:pointer-events-none aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 border border-[#0000001C]",
  {
    variants: {
      variant: {
        default:
          "bg-[#272EA7] text-[#FFFFFF] shadow-none " +
          // HOVER: 20% black overlay + cursor pointer
          "hover:bg-[linear-gradient(rgba(0,0,0,0.2),rgba(0,0,0,0.2)),linear-gradient(#272EA7,#272EA7)] hover:cursor-pointer " +
          // FOCUS: Blue glow
          "focus-visible:shadow-[2px_2px_20.4px_0px_#272EA7] focus-visible:ring-0 " +
          // ACTIVE (PRESSED): 40% black overlay
          "active:bg-[linear-gradient(rgba(0,0,0,0.4),rgba(0,0,0,0.4)),linear-gradient(#272EA7,#272EA7)] " +
          // DISABLED
          "disabled:bg-[#272EA726] disabled:text-white disabled:shadow-none",
        destructive:
          "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40",
        outline:
          "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost:
          "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-[50px] px-4 py-2 has-[>svg]:px-3",
        giant: "h-[50px] w-full max-w-[390px]",
        large: "h-[50px] w-[325px]",
        medium: "h-[50px] w-[225px]",
        small: "h-[50px] w-[105px]",
        tiny: "h-[50px] w-[75px]",
        icon: "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);
function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
