import { SessionsList } from "@/components/SessionsList";

// `?factory=<owner>/<repo>` narrows the list to that factory's sessions, as its Factory page links here.
export default async function SessionsPage({ searchParams }: { searchParams: Promise<{ factory?: string | string[] }> }) {
  const { factory } = await searchParams;
  return <SessionsList factory={typeof factory === "string" && factory ? factory : undefined} />;
}
