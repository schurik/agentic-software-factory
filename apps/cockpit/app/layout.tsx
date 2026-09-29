import type { Metadata } from "next";
import Link from "next/link";
import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cockpit",
  description: "Observe and steer the factories your stations report.",
};

// The backend's address is read when a page is served, not when the image is
// built: one published image serves every deployment (ADR 0004).
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const url = process.env.CONVEX_URL;
  return (
    <html lang="en">
      <body>
        <header className="bar">
          <Link href="/sessions" className="brand">cockpit</Link>
          <nav>
            <Link href="/sessions">Sessions</Link>
          </nav>
        </header>
        <main>
          {url ? (
            <Providers url={url}>{children}</Providers>
          ) : (
            <p className="notice">
              <code>CONVEX_URL</code> is not set: the cockpit does not know where its backend is.
            </p>
          )}
        </main>
      </body>
    </html>
  );
}
