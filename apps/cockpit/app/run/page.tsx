import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { runRedirect } from "@/components/run/dialog";

// Run a prompt is the header's dialog now (#108): an old `/run` link — or
// `/run?factory=acme/widgets` — goes back to where it was followed from, with
// the dialog open on that factory.
export default async function RunPage({ searchParams }: { searchParams: Promise<{ factory?: string | string[] }> }) {
  const [{ factory }, asked] = await Promise.all([searchParams, headers()]);
  redirect(runRedirect(asked.get("referer"), asked.get("host"), typeof factory === "string" ? factory : ""));
}
