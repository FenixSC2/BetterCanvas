import { createContext, useEffect, useMemo, useState } from "react";

const ThemeContext = createContext(null);

const STORAGE_KEYS = {
  theme: "cb_theme",
  density: "cb_density",
  font: "cb_font",
  fontVersion: "cb_font_v",
  customColors: "cb_custom_colors",
  rainbowCards: "cb_rainbow_cards",
};

const DEFAULT_THEME = "auto";
const DEFAULT_CUSTOM_COLORS = { primary: "#f5f6fb", secondary: "#ffffff" };

// CSS properties that custom theme injects inline — cleared when switching away
const CUSTOM_CSS_PROPS = [
  "--accent-500", "--accent-600", "--accent", "--accent-strong", "--accent-soft", "--accent-softer",
  "--on-accent", "--bg", "--bg-grad-1", "--bg-grad-2", "--bg-grad-3", "--dot-color",
  "--text", "--muted", "--muted-strong", "--surface", "--surface2",
  "--surface-glass", "--surface-glass-strong",
  "--border", "--border2", "--border-strong",
  "--shadow-sm", "--shadow", "--shadow-md", "--shadow-lg",
  "--highlight-inset", "--datePickerIconFilter",
  "--badge-danger-bg", "--badge-danger-border", "--badge-danger-text",
  "--text-on-bg", "--muted-on-bg", "--muted-strong-on-bg",
];

// --- Color utilities ---

function hexToRgb(hex) {
  const h = (hex || "#000000").replace(/^#/, "");
  return {
    r: parseInt(h.slice(0, 2), 16) || 0,
    g: parseInt(h.slice(2, 4), 16) || 0,
    b: parseInt(h.slice(4, 6), 16) || 0,
  };
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }
  return { h: h * 360, s: s * 100, l: l * 100 };
}

function hslToHex(h, s, l) {
  h /= 360; s /= 100; l /= 100;
  let r, g, b;
  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return "#" + [r, g, b].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("");
}

function relativeLuminance(r, g, b) {
  const toLinear = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

// primaryHex  → background color (user-picked)
// secondaryHex → surface/card color (user-picked)
// text         → auto from bg luminance
// highlight (--accent) → auto from primary hue, vivid
function deriveCustomTheme(primaryHex, secondaryHex) {
  const { r: pr, g: pg, b: pb } = hexToRgb(primaryHex);
  const { r: sr, g: sg, b: sb } = hexToRgb(secondaryHex);
  const pHsl = rgbToHsl(pr, pg, pb);
  const sHsl = rgbToHsl(sr, sg, sb);
  const pLum = relativeLuminance(pr, pg, pb);
  const sLum = relativeLuminance(sr, sg, sb);
  const darkBg = pLum < 0.20;
  const darkSurface = sLum < 0.20;
  const h = pHsl.h;

  // Auto-calculate highlight: vivid version of primary hue.
  // Fall back to indigo (h=240) when primary is near-achromatic.
  const hh = pHsl.s > 10 ? h : 240;
  const highlightHex = hslToHex(hh, Math.max(pHsl.s, 65), darkBg ? 65 : 52);
  const { r: hr, g: hg, b: hb } = hexToRgb(highlightHex);
  const hHsl = rgbToHsl(hr, hg, hb);
  const hLum = relativeLuminance(hr, hg, hb);

  const vars = {};

  // Highlight — auto-calculated
  vars["--accent-500"] = highlightHex;
  vars["--accent-600"] = hslToHex(hHsl.h, hHsl.s, Math.max(hHsl.l - 10, 10));
  vars["--accent"] = "var(--accent-500)";
  vars["--accent-strong"] = "var(--accent-600)";
  vars["--accent-soft"] = `color-mix(in srgb, var(--accent) ${darkBg ? "22%" : "14%"}, transparent)`;
  vars["--accent-softer"] = `color-mix(in srgb, var(--accent) ${darkBg ? "12%" : "8%"}, transparent)`;
  vars["--on-accent"] = hLum > 0.35 ? "#000000" : "#ffffff";

  // Background — primary as-is
  vars["--bg"] = primaryHex;
  vars["--bg-grad-1"] = `oklch(${darkBg ? "55%" : "82%"} 0.18 ${Math.round(h)} / ${darkBg ? "0.40" : "0.32"})`;
  vars["--bg-grad-2"] = `oklch(${darkBg ? "50%" : "84%"} 0.16 ${Math.round((h + 30) % 360)} / ${darkBg ? "0.30" : "0.22"})`;
  vars["--bg-grad-3"] = `oklch(${darkBg ? "55%" : "87%"} 0.14 ${Math.round((h - 30 + 360) % 360)} / ${darkBg ? "0.28" : "0.25"})`;
  vars["--dot-color"] = `oklch(${darkBg ? "85%" : "35%"} 0.05 ${Math.round(h)} / 0.10)`;

  // Text — auto from surface luminance (most text sits on cards/surfaces)
  const textHex = darkSurface ? "#eef0f7" : "#0c0d12";
  const { r: tr, g: tg, b: tb } = hexToRgb(textHex);
  vars["--text"] = textHex;
  vars["--muted"] = darkSurface ? "rgba(238, 240, 247, 0.62)" : `rgba(${tr}, ${tg}, ${tb}, 0.60)`;
  vars["--muted-strong"] = darkSurface ? "rgba(238, 240, 247, 0.82)" : `rgba(${tr}, ${tg}, ${tb}, 0.78)`;

  // Text on bg — used by elements that sit directly on the page background (e.g. welcome hero)
  const bgTextHex = darkBg ? "#eef0f7" : "#0c0d12";
  const { r: br, g: bg_, b: bb } = hexToRgb(bgTextHex);
  vars["--text-on-bg"] = bgTextHex;
  vars["--muted-on-bg"] = darkBg ? "rgba(238, 240, 247, 0.62)" : `rgba(${br}, ${bg_}, ${bb}, 0.60)`;
  vars["--muted-strong-on-bg"] = darkBg ? "rgba(238, 240, 247, 0.82)" : `rgba(${br}, ${bg_}, ${bb}, 0.78)`;

  // Surfaces — secondary as-is
  vars["--surface"] = secondaryHex;
  vars["--surface2"] = hslToHex(sHsl.h, sHsl.s, Math.max(sHsl.l - 3, 2));
  vars["--surface-glass"] = `rgba(${sr}, ${sg}, ${sb}, ${darkBg ? "0.55" : "0.70"})`;
  vars["--surface-glass-strong"] = `rgba(${sr}, ${sg}, ${sb}, ${darkBg ? "0.78" : "0.86"})`;

  // Borders from text color
  vars["--border"] = darkSurface ? "rgba(238, 240, 247, 0.10)" : `rgba(${tr}, ${tg}, ${tb}, 0.08)`;
  vars["--border2"] = darkSurface ? "rgba(238, 240, 247, 0.18)" : `rgba(${tr}, ${tg}, ${tb}, 0.14)`;
  vars["--border-strong"] = darkSurface ? "rgba(238, 240, 247, 0.30)" : `rgba(${tr}, ${tg}, ${tb}, 0.22)`;

  // Shadows + misc
  if (darkSurface) {
    vars["--shadow-sm"] = "0 1px 2px rgba(0, 0, 0, 0.4)";
    vars["--shadow"] = "0 6px 18px rgba(0, 0, 0, 0.40), 0 1px 2px rgba(0, 0, 0, 0.3)";
    vars["--shadow-md"] = "0 14px 38px rgba(0, 0, 0, 0.45), 0 2px 8px rgba(0, 0, 0, 0.3)";
    vars["--shadow-lg"] = "0 30px 70px rgba(0, 0, 0, 0.55), 0 8px 20px rgba(0, 0, 0, 0.4)";
    vars["--highlight-inset"] = "inset 0 1px 0 rgba(255, 255, 255, 0.06)";
    vars["--datePickerIconFilter"] = "invert(1)";
    vars["--badge-danger-bg"] = "var(--badge-danger-bg-strong)";
    vars["--badge-danger-border"] = "var(--badge-danger-border-strong)";
    vars["--badge-danger-text"] = "var(--badge-danger-text-strong)";
  } else {
    vars["--shadow-sm"] = `0 1px 2px rgba(${tr}, ${tg}, ${tb}, 0.05)`;
    vars["--shadow"] = `0 2px 8px rgba(${tr}, ${tg}, ${tb}, 0.06), 0 1px 2px rgba(${tr}, ${tg}, ${tb}, 0.04)`;
    vars["--shadow-md"] = `0 10px 28px rgba(${tr}, ${tg}, ${tb}, 0.09), 0 2px 6px rgba(${tr}, ${tg}, ${tb}, 0.05)`;
    vars["--shadow-lg"] = `0 24px 60px rgba(${tr}, ${tg}, ${tb}, 0.16), 0 6px 18px rgba(${tr}, ${tg}, ${tb}, 0.08)`;
    vars["--highlight-inset"] = "inset 0 1px 0 rgba(255, 255, 255, 0.65)";
  }

  // datePickerIconFilter follows surface, not bg
  if (darkSurface && !darkBg) {
    vars["--datePickerIconFilter"] = "invert(1)";
  }

  return vars;
}

// --- Provider ---

function readStored(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? v : fallback;
  } catch {
    return fallback;
  }
}

const DEFAULT_FONT = "inter";

// "system" used to render Inter. It now means the device's UI font, so anyone
// still on it (including everyone who never changed the setting) moves to Inter
// once, keeping what they see unchanged.
function readFont() {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.font);
    if (localStorage.getItem(STORAGE_KEYS.fontVersion) !== "2") {
      localStorage.setItem(STORAGE_KEYS.fontVersion, "2");
      if (!stored || stored === "system") return DEFAULT_FONT;
    }
    return stored || DEFAULT_FONT;
  } catch {
    return DEFAULT_FONT;
  }
}

function readCustomColors() {
  try {
    const v = localStorage.getItem(STORAGE_KEYS.customColors);
    if (!v) return DEFAULT_CUSTOM_COLORS;
    const parsed = JSON.parse(v);
    // Migrate old format that used "accent" instead of "secondary"
    if (parsed.accent && !parsed.secondary) {
      return { primary: parsed.primary || DEFAULT_CUSTOM_COLORS.primary, secondary: DEFAULT_CUSTOM_COLORS.secondary };
    }
    return { ...DEFAULT_CUSTOM_COLORS, ...parsed };
  } catch {
    return DEFAULT_CUSTOM_COLORS;
  }
}

function applyToDocument({ theme, density, font }) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.density = density;
  root.dataset.font = font;
}

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(() => readStored(STORAGE_KEYS.theme, DEFAULT_THEME));
  const [density, setDensityState] = useState(() => readStored(STORAGE_KEYS.density, "comfortable"));
  const [font, setFontState] = useState(readFont);
  const [customColors, setCustomColorsState] = useState(readCustomColors);
  const [rainbowCards, setRainbowCardsState] = useState(() => readStored(STORAGE_KEYS.rainbowCards, "dark"));

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

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "custom") {
      const vars = deriveCustomTheme(customColors.primary, customColors.secondary);
      for (const [key, val] of Object.entries(vars)) {
        root.style.setProperty(key, val);
      }
    } else {
      CUSTOM_CSS_PROPS.forEach((p) => root.style.removeProperty(p));
    }
  }, [theme, customColors]);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "rainbow") {
      root.dataset.rainbowCards = rainbowCards;
    } else {
      delete root.dataset.rainbowCards;
    }
  }, [theme, rainbowCards]);

  const api = useMemo(
    () => ({
      theme,
      density,
      font,
      customColors,
      rainbowCards,
      setTheme: (t) => setThemeState(t),
      setDensity: (d) => setDensityState(d),
      setFont: (f) => setFontState(f),
      setCustomColors: (c) => {
        setCustomColorsState(c);
        try {
          localStorage.setItem(STORAGE_KEYS.customColors, JSON.stringify(c));
        } catch {
          // ignore
        }
      },
      setRainbowCards: (v) => {
        setRainbowCardsState(v);
        try {
          localStorage.setItem(STORAGE_KEYS.rainbowCards, v);
        } catch {
          // ignore
        }
      },
    }),
    [theme, density, font, customColors, rainbowCards]
  );

  return <ThemeContext.Provider value={api}>{children}</ThemeContext.Provider>;
}

export { ThemeContext };
