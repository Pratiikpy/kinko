import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { storage } from "../lib/storage.ts";

export type Theme = "light" | "dark";

interface ThemeValue {
  readonly theme: Theme;
  readonly setTheme: (theme: Theme) => void;
  readonly toggle: () => void;
}

const ThemeContext = createContext<ThemeValue | null>(null);

const initial = (): Theme => (storage.get("theme") === "dark" ? "dark" : "light");

/**
 * Light is the default face of the product; dark is the reader's choice and
 * is remembered. index.html applies the saved choice before first paint.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(initial);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    storage.set("theme", t);
  }, []);

  const value = useMemo<ThemeValue>(
    () => ({
      theme,
      setTheme,
      toggle: () => {
        setTheme(theme === "dark" ? "light" : "dark");
      },
    }),
    [theme, setTheme],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const v = useContext(ThemeContext);
  if (!v) throw new Error("useTheme must be used inside ThemeProvider");
  return v;
}
