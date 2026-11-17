import { Breadcrumbs } from "@/features/workspace/feedback";
import ProjectForm from "@/features/workspace/project-form";

export default function NewProjectPage() {
  return (
    <div className="page-content narrow-page">
      <Breadcrumbs current="New project" />
      <header className="page-heading">
        <div>
          <h1>New project</h1>
          <p>Give your notes a place to belong.</p>
        </div>
      </header>
      <ProjectForm />
    </div>
  );
}
