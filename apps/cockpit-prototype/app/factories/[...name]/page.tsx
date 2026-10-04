import { FactoryPage } from "@/components/Factory";

export default async function Page({ params }: { params: Promise<{ name: string[] }> }) {
  return <FactoryPage name={(await params).name.map(decodeURIComponent).join("/")} />;
}
