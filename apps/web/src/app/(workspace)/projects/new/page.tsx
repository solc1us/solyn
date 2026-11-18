import { Breadcrumbs } from "@/features/workspace/feedback";
import ProjectForm from "@/features/workspace/project-form";

export default function NewProjectPage() {
  return (
    <div className="page-content narrow-page">
      <Breadcrumbs current="New project" />
      <header className="page-heading">
        <div>
          <h1>New project</h1>
        </div>
      </header>
      <ProjectForm />
    </div>
  );
}
