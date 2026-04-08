import { createContext, useEffect, useMemo, useState } from "react";

const ThemeContext = createContext(null);

const STORAGE_KEYS = {
  theme: "cb_theme",
  density: "cb_density",
  font: "cb_font",
};

function readStored(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? v : fallback;
  } catch {
    return fallback;
  }
}

function applyToDocument({ theme, density, font }) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.density = density;
  root.dataset.font = font;
}

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(() => readStored(STORAGE_KEYS.theme, "classic"));
  const [density, setDensityState] = useState(() => readStored(STORAGE_KEYS.density, "comfortable"));
  const [font, setFontState] = useState(() => readStored(STORAGE_KEYS.font, "system"));

  useEffect(() => {
    applyToDocument({ theme, density, font });
    try {
      localStorage.setItem(STORAGE_KEYS.theme, theme);
      localStorage.setItem(STORAGE_KEYS.density, density);
      localStorage.setItem(STORAGE_KEYS.font, font);
    } catch {
      // ignore
    }
  }, [theme, density, font]);

  const api = useMemo(
    () => ({
      theme,
      density,
      font,
      setTheme: (t) => setThemeState(t),
      setDensity: (d) => setDensityState(d),
      setFont: (f) => setFontState(f),
    }),
    [theme, density, font]
  );

  return <ThemeContext.Provider value={api}>{children}</ThemeContext.Provider>;
}

export { ThemeContext };
