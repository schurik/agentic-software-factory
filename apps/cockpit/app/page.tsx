import { Inbox } from "@/components/Inbox";

// The home page is the inbox (spec #40). `?open=<owner>/<repo>/<session>` opens that session's wait;
// `?factory=<owner>/<repo>` shows only that factory's, as its Factory page links to them.
export default async function Home({ searchParams }: { searchParams: Promise<{ open?: string | string[]; factory?: string | string[] }> }) {
  const { open, factory } = await searchParams;
  return <Inbox open={typeof open === "string" ? open : undefined} factory={typeof factory === "string" ? factory : undefined} />;
}
