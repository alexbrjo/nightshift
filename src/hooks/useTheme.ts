import { useEffect, useState } from "react";

const THEME_STORAGE_KEY = "nightshift-theme";

export function useTheme() {
  const [isDark, setIsDark] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem(THEME_STORAGE_KEY) === "dark";
  });

  useEffect(() => {
    if (isDark) {
      document.documentElement.dataset.theme = "dark";
      localStorage.setItem(THEME_STORAGE_KEY, "dark");
    } else {
      delete document.documentElement.dataset.theme;
      localStorage.removeItem(THEME_STORAGE_KEY);
    }
  }, [isDark]);

  return {
    isDark,
    toggleTheme: () => setIsDark((current) => !current),
  };
}
