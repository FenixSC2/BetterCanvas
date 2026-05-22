/**
 * Deterministic course color assignment.
 *
 * Each course gets one of 12 curated hues based on a stable hash of its id.
 * The values are in OKLCH so they read identically on light/dark surfaces.
 * Consumers get a small set of CSS-ready strings + the underlying hue so they
 * can mix their own variants when needed.
 */

const PALETTE = [
  { name: "indigo",     hue: 264 },
  { name: "violet",     hue: 285 },
  { name: "fuchsia",    hue: 320 },
  { name: "rose",       hue: 355 },
  { name: "amber",      hue: 55  },
  { name: "lime",       hue: 115 },
  { name: "emerald",    hue: 155 },
  { name: "teal",       hue: 180 },
  { name: "sky",        hue: 215 },
  { name: "blue",       hue: 245 },
  { name: "orange",     hue: 35  },
  { name: "slate",      hue: 230 },
];

function hashString(str) {
  let h = 2166136261;
  const s = String(str ?? "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function courseColor(courseId) {
  const slot = hashString(courseId) % PALETTE.length;
  const { name, hue } = PALETTE[slot];
  return {
    name,
    hue,
    // Tint strong enough to read but not so saturated it dominates
    fg: `oklch(60% 0.18 ${hue})`,
    fgSoft: `oklch(70% 0.14 ${hue})`,
    surface: `oklch(96% 0.045 ${hue})`,
    surfaceDark: `oklch(28% 0.08 ${hue})`,
    border: `oklch(82% 0.10 ${hue})`,
    borderDark: `oklch(45% 0.12 ${hue})`,
    gradStart: `oklch(72% 0.18 ${hue})`,
    gradEnd: `oklch(54% 0.20 ${hue + 25})`,
    // CSS custom property block, ready to spread onto a style attribute
    vars: {
      "--c-fg": `oklch(60% 0.18 ${hue})`,
      "--c-fg-soft": `oklch(70% 0.14 ${hue})`,
      "--c-surface": `oklch(96% 0.045 ${hue})`,
      "--c-surface-dark": `oklch(28% 0.08 ${hue})`,
      "--c-border": `oklch(82% 0.10 ${hue})`,
      "--c-border-dark": `oklch(45% 0.12 ${hue})`,
      "--c-grad-start": `oklch(72% 0.18 ${hue})`,
      "--c-grad-end": `oklch(54% 0.20 ${hue + 25})`,
      "--c-hue": String(hue),
    },
  };
}
