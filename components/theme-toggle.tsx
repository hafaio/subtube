"use client";

import { useTheme } from "next-themes";
import { type ReactElement, useEffect, useState } from "react";
import { MdContrast, MdDarkMode, MdLightMode } from "react-icons/md";

type ThemeChoice = "system" | "light" | "dark";

const NEXT: Record<ThemeChoice, ThemeChoice> = {
  system: "light",
  light: "dark",
  dark: "system",
};
// sun = light, moon = dark, half-and-half circle = follow system.
const ICON: Record<ThemeChoice, ReactElement> = {
  system: <MdContrast />,
  light: <MdLightMode />,
  dark: <MdDarkMode />,
};
const LABEL: Record<ThemeChoice, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

// Cycles system → light → dark. next-themes owns persistence and the pre-paint
// class on <html>; this is just the control surface.
export default function ThemeToggle(): ReactElement | null {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  // `theme` is unknown until mounted; render nothing server-side to avoid a
  // hydration mismatch on the icon/label.
  useEffect(() => setMounted(true), []);
  if (!mounted) {
    return null;
  }

  const choice = (theme as ThemeChoice) ?? "system";
  const next = NEXT[choice] ?? "light";
  return (
    <button
      type="button"
      className="flex items-center rounded p-1.5 text-base hover:bg-slate-100 dark:hover:bg-slate-800"
      onClick={() => setTheme(next)}
      title={`Theme: ${LABEL[choice]} (click for ${LABEL[next]})`}
      aria-label={`Theme: ${LABEL[choice]}`}
    >
      {ICON[choice]}
    </button>
  );
}
