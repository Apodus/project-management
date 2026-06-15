import * as React from "react";
import { ToggleGroup as ToggleGroupPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

// A single-select segmented control, styled like the `bg-muted` segmented look
// of TabsList/TabsTrigger. Mirrors the Radix wrapper convention in `ui/tabs.tsx`.

function ToggleGroup({
  className,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Root>) {
  return (
    <ToggleGroupPrimitive.Root
      data-slot="toggle-group"
      className={cn(
        "bg-muted text-muted-foreground inline-flex h-9 w-fit items-center justify-center rounded-lg p-[3px]",
        className,
      )}
      {...props}
    />
  );
}

function ToggleGroupItem({
  className,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Item>) {
  return (
    <ToggleGroupPrimitive.Item
      data-slot="toggle-group-item"
      className={cn(
        "text-foreground/60 hover:text-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:outline-ring data-[state=on]:bg-background data-[state=on]:text-foreground dark:data-[state=on]:border-input dark:data-[state=on]:bg-input/30 dark:data-[state=on]:text-foreground relative inline-flex h-[calc(100%-1px)] items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent px-3 py-1 text-sm font-medium transition-all focus-visible:outline-1 focus-visible:ring-[3px] disabled:pointer-events-none disabled:opacity-50 data-[state=on]:shadow-sm [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className,
      )}
      {...props}
    />
  );
}

export { ToggleGroup, ToggleGroupItem };
