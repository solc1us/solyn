import { headers } from "next/headers";
import { redirect } from "next/navigation";

import SignOutButton from "@/components/sign-out-button";

import { auth } from "../../services";

export default async function DashboardPage() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.user) {
    redirect("/login");
  }

  return (
    <main className="space-y-4 p-6">
      <h1>Workspace</h1>
      <p>You are signed in. The custom workspace interface is not available yet.</p>
      <SignOutButton />
    </main>
  );
}
