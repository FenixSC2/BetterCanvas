import { createContext, useEffect, useMemo, useState } from "react";

const ThemeContext = createContext(null);

const STORAGE_KEYS = {
  theme: "cb_theme",
  density: "cb_density",
};

function readStored(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? v : fallback;
  } catch {
    return fallback;
  }
}

function applyToDocument({ theme, density }) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.density = density;
}

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(() => readStored(STORAGE_KEYS.theme, "classic"));
  const [density, setDensityState] = useState(() => readStored(STORAGE_KEYS.density, "comfortable"));

  useEffect(() => {
    applyToDocument({ theme, density });
    try {
      localStorage.setItem(STORAGE_KEYS.theme, theme);
      localStorage.setItem(STORAGE_KEYS.density, density);
    } catch {
      // ignore
    }
  }, [theme, density]);

  const api = useMemo(
    () => ({
      theme,
      density,
      setTheme: (t) => setThemeState(t),
      setDensity: (d) => setDensityState(d),
    }),
    [theme, density]
  );

  return <ThemeContext.Provider value={api}>{children}</ThemeContext.Provider>;
}

export { ThemeContext };
