import { SetupCallback } from "@/components/Setup";

// GitHub sends the admin's browser back here once the App exists, with the
// code that is traded for its key and secrets.
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ code?: string; state?: string }>;
}) {
  const { code = "", state = "" } = await searchParams;
  return <SetupCallback code={code} state={state} />;
}
