import type { Metadata } from "next";
import type { ReactElement, ReactNode } from "react";
import Providers from "../components/providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "subtube",
  description: "Your subscriptions, your filters, no algorithm.",
};

export default function RootLayout({
  children,
}: {
  children: ReactNode;
}): ReactElement {
  // suppressHydrationWarning: next-themes sets the `class`/`style` on <html>
  // before hydration, which would otherwise mismatch the server markup.
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="bg-white text-slate-900 dark:bg-slate-900 dark:text-slate-100">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
