"use client";

import { Button } from "@solyn/ui/components/button";
import { Input } from "@solyn/ui/components/input";
import { Label } from "@solyn/ui/components/label";
import { Textarea } from "@solyn/ui/components/textarea";
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
  const [savedFeedback, setSavedFeedback] = useState(false);
  const [navigating, startTransition] = useTransition();
  const pending = saving || navigating;
  const dirty = name !== (saved?.name ?? "") || description !== (saved?.description ?? "");
  useUnsavedChanges(dirty || pending);
  function change(field: "name" | "description", value: string) {
    setSavedFeedback(false);
    if (field === "name") setName(value);
    else setDescription(value);
    setErrors((current) => {
      if (!current[field]) return current;
      const parsed = createProjectInput.safeParse({
        name: field === "name" ? value : name,
        description: (field === "description" ? value : description) || null,
      });
      const next = { ...current };
      delete next[field];
      if (!parsed.success) {
        const message = fieldErrors(parsed.error)[field];
        if (message) next[field] = message;
      }
      return next;
    });
  }

  return (
    <form
      className="project-form mt-[28px] w-full [@media(max-width:760px)]:mt-[24px]"
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
        setSavedFeedback(false);
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
          setSavedFeedback(true);
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
      <div className="project-toolbar mb-[20px] flex items-center justify-end gap-[12px] pb-[16px] [@media(max-width:760px)]:gap-[10px]">
        <p role="status" className="save-indicator text-[13px] text-muted-foreground">
          {pending ? "Saving…" : dirty ? "Unsaved changes" : savedFeedback ? "Saved" : ""}
        </p>
        <Button className="control" type="submit" disabled={pending || (!!saved && !dirty)}>
          {pending ? "Saving…" : saved ? "Save changes" : "Create project"}
        </Button>
      </div>
      <FieldError id="project-form-error" message={errors.form} />
      <fieldset disabled={pending} className="form-fields grid gap-[20px]">
        <div className="field grid gap-[9px]">
          <Label htmlFor="project-name">
            Project name{" "}
            <span className="required-hint text-[12px] font-normal text-muted-foreground">
              (required)
            </span>
          </Label>
          <Input
            id="project-name"
            name="name"
            className="form-control"
            value={name}
            onChange={(event) => change("name", event.target.value)}
            maxLength={200}
            autoComplete="off"
            required
            aria-invalid={!!errors.name}
            aria-describedby={errors.name ? "project-name-error" : undefined}
            placeholder="Project name"
          />
          <FieldError id="project-name-error" message={errors.name} />
        </div>
        <div className="field grid gap-[9px]">
          <Label htmlFor="project-description">
            Description{" "}
            <span className="required-hint text-[12px] font-normal text-muted-foreground">
              (optional)
            </span>
          </Label>
          <Textarea
            id="project-description"
            name="description"
            className="form-control description-input h-[160px] max-h-[40dvh] field-sizing-fixed resize-none overflow-y-auto"
            value={description}
            onChange={(event) => change("description", event.target.value)}
            maxLength={5000}
            aria-invalid={!!errors.description}
            aria-describedby={errors.description ? "project-description-error" : undefined}
            autoComplete="off"
            placeholder="What is this project about?"
          />
          <FieldError id="project-description-error" message={errors.description} />
        </div>
      </fieldset>
      {error ? <MutationError code={error} /> : null}
      {error === "UNAVAILABLE" && !saved ? (
        <p className="field-help text-[12px] leading-[1.6] text-muted-foreground">
          Check your projects before retrying, in case the project was created.
        </p>
      ) : null}
    </form>
  );
}
