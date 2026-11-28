import { Breadcrumbs } from "@/features/workspace/feedback";
import ProjectForm from "@/features/workspace/project-form";

export default function NewProjectPage() {
  return (
    <div className="page-content narrow-page px-[24px] pt-[20px] pb-[40px] [@media(max-width:760px)]:[padding:20px_max(16px,env(safe-area-inset-right))_max(40px,env(safe-area-inset-bottom))_max(16px,env(safe-area-inset-left))]">
      <Breadcrumbs current="New project" />
      <ProjectForm />
    </div>
  );
}
