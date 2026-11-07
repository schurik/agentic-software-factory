"use client";

import { ConvexProvider, ConvexReactClient } from "convex/react";
import { useState } from "react";
import { Shell } from "@/components/Shell";
import type { Build } from "@/convex/model/build";

export function Providers({ url, build, children }: { url: string; build: Build; children: React.ReactNode }) {
  const [client] = useState(() => new ConvexReactClient(url));
  return (
    <ConvexProvider client={client}>
      <Shell build={build}>{children}</Shell>
    </ConvexProvider>
  );
}
