"use client";

import { ThemeProvider } from "next-themes";
import type { ReactElement, ReactNode } from "react";

export default function Providers({
  children,
}: {
  children: ReactNode;
}): ReactElement {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      {children}
    </ThemeProvider>
  );
}
