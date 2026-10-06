"use client";

import { useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { api } from "@/convex/_generated/api";
import { soleAddress } from "./factory/view";
import { useSignIn } from "./signIn";
import { Loading } from "./ui";

/**
 * Where an old `/cost` link lands (#119): a factory's Overview holds what it
 * spent now, so it goes on to the Overview of the one factory the viewer can
 * read, or to the Factories list to pick one.
 */
export function CostRedirect() {
  const signIn = useSignIn();
  const listed = useQuery(api.factories.list, { signIn });
  const router = useRouter();
  const to = listed === undefined ? null : soleAddress(listed?.factories.map((row) => row.repo) ?? [], "overview");
  useEffect(() => {
    if (to !== null) router.replace(to);
  }, [to, router]);
  return <Loading />;
}
