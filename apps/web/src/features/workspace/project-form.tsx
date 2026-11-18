"use client";

import { Button } from "@solyn/ui/components/button";
import { Input } from "@solyn/ui/components/input";
import { Label } from "@solyn/ui/components/label";
import { Textarea } from "@solyn/ui/components/textarea";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { createProject, updateProject } from "./actions";
import { createProjectInput, type ErrorCode } from "./contracts";
import { FieldError, MutationError } from "./feedback";
import { fieldErrors, type FieldErrors, type Project } from "./presentation";
import { useUnsavedChanges } from "./use-unsaved-changes";

export default function ProjectForm({ initial }: { initial?: Project }) {
  const router = useRouter();
  const [saved, setSaved] = useState(initial);
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<ErrorCode | null>(null);
  const [saving, setSaving] = useState(false);
  const [navigating, startTransition] = useTransition();
  const pending = saving || navigating;
  const dirty = name !== (saved?.name ?? "") || description !== (saved?.description ?? "");
  useUnsavedChanges(dirty || pending);

  return (
    <form
      className="project-form"
      noValidate
      data-unsaved={dirty}
      aria-busy={pending}
      onSubmit={async (event) => {
        event.preventDefault();
        if (pending) return;
        const form = event.currentTarget;
        const parsed = createProjectInput.safeParse({ name, description: description || null });
        if (!parsed.success) {
          setErrors(fieldErrors(parsed.error));
          requestAnimationFrame(() =>
            form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
          );
          return;
        }
        setErrors({});
        setError(null);
        setSaving(true);
        try {
          const result = saved
            ? await updateProject({ projectId: saved.id, ...parsed.data })
            : await createProject(parsed.data);
          if (!result.ok) {
            setError(result.error.code);
            return;
          }
          setSaved(result.data);
          setName(result.data.name);
          setDescription(result.data.description ?? "");
          startTransition(() => {
            router.push(`/projects/${result.data.id}`);
            router.refresh();
          });
        } catch {
          setError("UNAVAILABLE");
        } finally {
          setSaving(false);
        }
      }}
    >
      <fieldset disabled={pending} className="form-fields">
        <div className="field">
          <Label htmlFor="project-name">
            Project name <span className="required-hint">(required)</span>
          </Label>
          <Input
            id="project-name"
            name="name"
            className="form-control"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={200}
            autoComplete="off"
            required
            aria-invalid={!!errors.name}
            aria-describedby={errors.name ? "project-name-error" : undefined}
            placeholder="Project name"
          />
          <FieldError id="project-name-error" message={errors.name} />
        </div>
        <div className="field">
          <Label htmlFor="project-description">
            Description <span className="required-hint">(optional)</span>
          </Label>
          <Textarea
            id="project-description"
            name="description"
            className="form-control description-input"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={5000}
            aria-invalid={!!errors.description}
            aria-describedby={`project-description-help${errors.description ? " project-description-error" : ""}`}
            autoComplete="off"
            placeholder="What is this project about?"
          />
          <p id="project-description-help" className="field-help">
            Optional context for this project.
          </p>
          <FieldError id="project-description-error" message={errors.description} />
        </div>
      </fieldset>
      {error ? <MutationError code={error} /> : null}
      {error === "UNAVAILABLE" && !saved ? (
        <p className="field-help">
          Check your projects before retrying, in case the project was created.
        </p>
      ) : null}
      <div className="form-footer">
        <Link className="text-link" href={saved ? `/projects/${saved.id}` : "/projects"}>
          Cancel
        </Link>
        <Button className="control" type="submit" disabled={pending || (!!saved && !dirty)}>
          {pending ? "Saving…" : saved ? "Save changes" : "Create project"}
        </Button>
      </div>
      <p role="status" className="field-help">
        {pending ? "Saving your project…" : dirty ? "You have unsaved changes." : ""}
      </p>
    </form>
  );
}
