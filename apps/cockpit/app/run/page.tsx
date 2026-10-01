import { RunPrompt } from "@/components/run/RunPrompt";

// Run a prompt workflow on one of your own stations: `?factory=acme/widgets` picks the factory.
export default async function RunPage({ searchParams }: { searchParams: Promise<{ factory?: string | string[] }> }) {
  const { factory } = await searchParams;
  return <RunPrompt factory={typeof factory === "string" ? factory : ""} />;
}
