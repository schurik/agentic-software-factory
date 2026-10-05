import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { runRedirect } from "@/components/run/dialog";

// Run a prompt is the header's dialog now (#108): an old `/run` link — or
// `/run?factory=acme/widgets` — goes back to where it was followed from, with
// the dialog open on that factory.
export default async function RunPage({ searchParams }: { searchParams: Promise<{ factory?: string | string[] }> }) {
  const [{ factory }, asked] = await Promise.all([searchParams, headers()]);
  // Behind a proxy the request's own host is the proxy's upstream, not the one the page was read at.
  const host = asked.get("x-forwarded-host")?.split(",")[0].trim() || asked.get("host");
  redirect(runRedirect(asked.get("referer"), host, typeof factory === "string" ? factory : ""));
}
