import { SessionPage } from "@/components/SessionPage";

export default async function Page({
  params,
}: {
  params: Promise<{ owner: string; repo: string; session: string }>;
}) {
  const { owner, repo, session } = await params;
  return <SessionPage factory={`${decodeURIComponent(owner)}/${decodeURIComponent(repo)}`}
                      session={decodeURIComponent(session)} />;
}
