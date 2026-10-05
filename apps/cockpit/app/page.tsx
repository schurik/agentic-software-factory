import { Inbox } from "@/components/Inbox";

// The home page is the inbox (spec #40). `?open=<owner>/<repo>/<session>` opens that session's wait
// in the drawer, on its `?tab=`; `?factory=<owner>/<repo>` shows only that factory's, as its Factory page links to them.
export default async function Home({ searchParams }: {
  searchParams: Promise<{ open?: string | string[]; factory?: string | string[]; tab?: string | string[] }>;
}) {
  const { open, factory, tab } = await searchParams;
  const one = (value: string | string[] | undefined) => (typeof value === "string" ? value : undefined);
  return <Inbox open={one(open)} factory={one(factory)} tab={one(tab)} />;
}
