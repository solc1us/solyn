import { cn } from "@solyn/ui/lib/utils";
import * as React from "react";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex h-auto field-sizing-content min-h-[38px] w-full resize-none rounded-[7px] border border-input bg-canvas px-[10px] py-[7px] text-[16px] leading-[1.6] text-foreground shadow-none transition-[border-color] duration-[120ms] ease-[ease] outline-none placeholder:text-muted-foreground placeholder:opacity-100 focus:not-aria-[invalid=true]:border-ring disabled:cursor-not-allowed disabled:opacity-70 aria-invalid:border-destructive [@media(max-width:760px)]:min-h-[44px] [@media(pointer:coarse)]:min-h-[44px]",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
