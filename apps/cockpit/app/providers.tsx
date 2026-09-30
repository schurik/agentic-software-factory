"use client";

import { ConvexProvider, ConvexReactClient } from "convex/react";
import { useState } from "react";
import { Shell } from "@/components/Shell";

export function Providers({ url, children }: { url: string; children: React.ReactNode }) {
  const [client] = useState(() => new ConvexReactClient(url));
  return (
    <ConvexProvider client={client}>
      <Shell>{children}</Shell>
    </ConvexProvider>
  );
}
