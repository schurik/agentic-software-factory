import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata } from "next";
import { BEFORE_PAINT } from "@/components/theme";
import { Notice } from "@/components/ui";
import { buildFromEnv } from "@/convex/model/build";
import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cockpit",
  description: "Observe and steer the factories your stations report.",
};

// The backend's address is read when a page is served, not when the image is
// built: one published image serves every deployment (ADR 0004). So is which
// build this is, which the image carries in its environment (the footer).
export const dynamic = "force-dynamic";

// Geist comes with the `geist` package and is served from the app itself, so
// building the image asks no font host for anything. The theme is set by a
// script before the body is painted — so a dark page never flashes light —
// which is why <html> differs from the server's markup by its data-theme.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  const url = process.env.CONVEX_URL;
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: BEFORE_PAINT }} />
      </head>
      <body className="min-h-dvh [overflow-wrap:anywhere]">
        {url ? (
          <Providers url={url} build={buildFromEnv(process.env)}>{children}</Providers>
        ) : (
          <main className="mx-auto max-w-[1280px] px-4 pt-8 md:px-6">
            <Notice>
              <code>CONVEX_URL</code> is not set: the cockpit does not know where its backend is.
            </Notice>
          </main>
        )}
      </body>
    </html>
  );
}
