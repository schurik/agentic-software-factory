// PROTOTYPE, throwaway: the redesigned cockpit on static data. See ../README.md.
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata } from "next";
import { Suspense, type ReactNode } from "react";
import { Shell } from "@/components/Shell";
import { Provider } from "@/components/state";
import "./globals.css";

export const metadata: Metadata = { title: "cockpit · prototype" };

// Before paint: the remembered theme, else the system's — so dark never flashes light.
const theme = `try{var t=localStorage.getItem("theme");document.documentElement.dataset.theme=t||(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light")}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: theme }} />
      </head>
      <body>
        <Suspense>
          <Provider>
            <Shell>{children}</Shell>
          </Provider>
        </Suspense>
      </body>
    </html>
  );
}
