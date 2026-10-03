import { notFound } from "next/navigation";
import { SessionPage } from "@/components/SessionPage";
import { sessionById } from "@/lib/data";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const s = sessionById((await params).id);
  if (!s) notFound();
  return <SessionPage s={s} />;
}
