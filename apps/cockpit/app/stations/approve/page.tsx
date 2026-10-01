import { StationApproval } from "@/components/Stations";

// Where `asf station register` sends a person: `?code=ABCD-EF23` is the code it printed.
export default async function ApprovePage({ searchParams }: { searchParams: Promise<{ code?: string | string[] }> }) {
  const { code } = await searchParams;
  return <StationApproval code={typeof code === "string" ? code : ""} />;
}
