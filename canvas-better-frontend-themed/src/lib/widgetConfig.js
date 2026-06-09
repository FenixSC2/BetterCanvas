const STORAGE_KEY = 'heroWidgets:v1';

export const WIDGET_PRESETS = {
  grades: {
    label: 'Grade Snapshot',
    description: 'Current grade for each enrolled course',
    defaultConfig: { showScore: false, maxCourses: null },
    unique: true,
  },
  today_ring: {
    label: "Today's Workload",
    description: 'Ring chart of missing and due-soon items',
    defaultConfig: { showLegend: true },
    unique: true,
  },
  quick_stats: {
    label: 'Quick Stats',
    description: 'Key numbers at a glance: missing, due soon, GPA, todos',
    defaultConfig: { showMissing: true, showDueSoon: true, showGpa: true, showTodos: true },
    unique: true,
  },
};

const DEFAULT_WIDGETS = [
  { id: 'default_grades', type: 'grades', visible: true, config: { showScore: false, maxCourses: null } },
  { id: 'default_today_ring', type: 'today_ring', visible: true, config: { showLegend: true } },
];

function safeJsonParse(raw, fallback) {
  try { return JSON.parse(raw); } catch { return fallback; }
}

export function loadWidgetConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_WIDGETS;
    const parsed = safeJsonParse(raw, null);
    if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_WIDGETS;
    // Filter out unknown types
    return parsed.filter((w) => WIDGET_PRESETS[w.type]);
  } catch {
    return DEFAULT_WIDGETS;
  }
}

export function saveWidgetConfig(widgets) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(widgets));
  } catch {
    // ignore
  }
}

export function makeWidgetId() {
  return `w_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}
