import { Input as InputPrimitive } from "@base-ui/react/input";
import { cn } from "@solyn/ui/lib/utils";
import * as React from "react";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        "h-auto min-h-[38px] w-full min-w-0 rounded-[7px] border border-input bg-canvas px-[10px] py-[7px] text-[16px] leading-[1.6] text-foreground shadow-none transition-[border-color] duration-[120ms] ease-[ease] outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-xs file:font-medium file:text-foreground placeholder:text-muted-foreground placeholder:opacity-100 focus:not-aria-[invalid=true]:border-ring disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-70 aria-invalid:border-destructive [@media(max-width:760px)]:min-h-[44px] [@media(pointer:coarse)]:min-h-[44px]",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
