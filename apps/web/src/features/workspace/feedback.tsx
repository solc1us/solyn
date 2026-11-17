import Link from "next/link";

import type { ErrorCode } from "./contracts";
import { errorMessage } from "./presentation";

export function MutationError({ code }: { code: ErrorCode }) {
  return (
    <div className="feedback feedback-error" role="alert">
      <p>{errorMessage(code)}</p>
      {code === "UNAUTHENTICATED" ? (
        <Link href="/login" target="_blank" rel="noopener noreferrer">
          Sign in in a new tab
        </Link>
      ) : null}
    </div>
  );
}
export function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? (
    <p id={id} className="field-error" aria-live="polite">
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
    <nav className="breadcrumbs" aria-label="Breadcrumb">
      <ol>
        <li>
          <Link href="/projects">Projects</Link>
        </li>
        {project ? (
          <li>
            <span aria-hidden="true">/</span>
            <Link href={`/projects/${project.id}`}>{project.name}</Link>
          </li>
        ) : null}
        {current ? (
          <li>
            <span aria-hidden="true">/</span>
            <span aria-current="page">{current}</span>
          </li>
        ) : null}
      </ol>
    </nav>
  );
}
