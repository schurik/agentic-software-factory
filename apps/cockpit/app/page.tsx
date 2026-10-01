import { Inbox } from "@/components/Inbox";

// The home page is the inbox (spec #40). `?open=<owner>/<repo>/<session>` opens that session's wait.
export default async function Home({ searchParams }: { searchParams: Promise<{ open?: string | string[] }> }) {
  const { open } = await searchParams;
  return <Inbox open={typeof open === "string" ? open : undefined} />;
}
