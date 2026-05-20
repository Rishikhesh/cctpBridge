import { useCallback, useEffect, useState } from "react";

export type ThemeMode = "light" | "dark";

const THEME_KEY = "cctp:theme";

function readStored(): ThemeMode {
  if (typeof window === "undefined") return "dark";
  const v = localStorage.getItem(THEME_KEY);
  return v === "light" || v === "dark" ? v : "dark";
}

export function useTheme() {
  const [theme, setThemeState] = useState<ThemeMode>(readStored);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  const setTheme = useCallback((t: ThemeMode) => {
    setThemeState(t);
    localStorage.setItem(THEME_KEY, t);
  }, []);

  const toggleTheme = useCallback(
    () => setTheme(theme === "dark" ? "light" : "dark"),
    [theme, setTheme],
  );

  return { theme, setTheme, toggleTheme };
}
