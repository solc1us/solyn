import Link from "next/link";

import type { ErrorCode } from "./contracts";
import { errorMessage } from "./presentation";

export function MutationError({ code }: { code: ErrorCode }) {
  return (
    <div
      className="mt-[22px] rounded-[7px] border border-[#71404c] bg-[#342333] px-[16px] py-[14px] text-[14px] text-[#ffd2d7]"
      role="alert"
    >
      <p>{errorMessage(code)}</p>
      {code === "UNAUTHENTICATED" ? (
        <Link
          href="/login"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-[8px] inline-block underline"
        >
          Sign in in a new tab
        </Link>
      ) : null}
    </div>
  );
}
export function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? (
    <p id={id} className="field-error text-[13px] text-destructive" aria-live="polite">
      {message}
    </p>
  ) : null;
}
export function Breadcrumbs({
  project,
  current,
}: {
  project?: { id: string; name: string };
  current?: string;
}) {
  return (
    <nav
      className="breadcrumbs mb-[16px] text-[13px] text-muted-foreground [@media(max-width:760px)]:mb-[22px]"
      aria-label="Breadcrumb"
    >
      <ol className="flex list-none flex-wrap gap-[10px] p-0">
        <li className="flex min-w-0 items-baseline gap-[10px] [overflow-wrap:anywhere]">
          <Link href="/projects" className="[&:hover]:text-[#eff4ff] [&:hover]:underline">
            Projects
          </Link>
        </li>
        {project ? (
          <li className="flex min-w-0 items-baseline gap-[10px] [overflow-wrap:anywhere]">
            <span aria-hidden="true">/</span>
            <Link
              href={`/projects/${project.id}`}
              className="[&:hover]:text-[#eff4ff] [&:hover]:underline"
            >
              {project.name}
            </Link>
          </li>
        ) : null}
        {current ? (
          <li className="flex min-w-0 items-baseline gap-[10px] [overflow-wrap:anywhere]">
            <span aria-hidden="true">/</span>
            <span aria-current="page" className="text-[#d4def2]">
              {current}
            </span>
          </li>
        ) : null}
      </ol>
    </nav>
  );
}
