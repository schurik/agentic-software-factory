import { Now } from "@/components/now/Now";

// The home page is Now (#115). `?open=<owner>/<repo>/<session>` opens that session's gate in the
// drawer, on its `?tab=`; `?factory=<owner>/<repo>` shows only that factory's, as its Factory page links to it.
export default async function Home({ searchParams }: {
  searchParams: Promise<{ open?: string | string[]; factory?: string | string[]; tab?: string | string[] }>;
}) {
  const { open, factory, tab } = await searchParams;
  const one = (value: string | string[] | undefined) => (typeof value === "string" ? value : undefined);
  return <Now open={one(open)} factory={one(factory)} tab={one(tab)} />;
}
