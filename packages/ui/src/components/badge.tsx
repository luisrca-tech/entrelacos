import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "../lib/utils";

const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold whitespace-nowrap outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25 [&>svg]:size-3 [&>svg]:pointer-events-none",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground",
        outline: "border-border bg-transparent text-foreground",
        ghost: "border-transparent bg-transparent text-foreground",
        link: "border-transparent bg-transparent text-primary underline-offset-4 hover:underline",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

function Badge({
  className,
  variant = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants>): React.JSX.Element {
  return useRender({
    defaultTagName: "span",
    props: { ...props, className: cn(badgeVariants({ variant }), className) },
    render,
    state: { slot: "badge", variant },
  });
}

export { Badge, badgeVariants };
