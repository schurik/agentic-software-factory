import { SignInCallback } from "@/components/SignInPage";

// The forge sends a browser back here from its sign-in page.
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ code?: string; state?: string; error_description?: string }>;
}) {
  const { code = "", state = "", error_description: refused = "" } = await searchParams;
  return <SignInCallback code={code} state={state} refused={refused} />;
}
