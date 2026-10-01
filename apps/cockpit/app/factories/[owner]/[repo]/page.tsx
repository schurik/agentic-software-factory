import { FactoryPage } from "@/components/factory/FactoryPage";

export default async function Page({ params }: { params: Promise<{ owner: string; repo: string }> }) {
  const { owner, repo } = await params;
  return <FactoryPage factory={`${decodeURIComponent(owner)}/${decodeURIComponent(repo)}`} />;
}
