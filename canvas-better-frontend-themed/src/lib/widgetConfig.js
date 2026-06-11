const STORAGE_KEY = 'heroWidgets:v1';

export const WIDGET_PRESETS = {
  grades: {
    label: 'Grade Snapshot',
    description: 'Current grade for each enrolled course, with GPA',
    defaultConfig: { showScore: false, maxCourses: null, showGpa: true },
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
    description: 'GPA arc gauge and personal todos at a glance',
    defaultConfig: { showMissing: false, showDueSoon: false, showGpa: true, showTodos: true },
    unique: true,
  },
  due_soon: {
    label: 'Due Soon',
    description: 'Assignments and todos due in the next 24 hours',
    defaultConfig: {},
    unique: true,
  },
  missing_work: {
    label: 'Missing Work',
    description: 'Assignments marked missing across all courses',
    defaultConfig: {},
    unique: true,
  },
  announcements: {
    label: 'Announcements',
    description: 'Recent course announcements, refreshed every 3 minutes',
    defaultConfig: {},
    unique: true,
  },
  grade_overview: {
    label: 'Grade Overview',
    description: 'Full course grade list with running GPA',
    defaultConfig: { showGpa: true },
    unique: true,
  },
  notifications: {
    label: 'Notifications',
    description: 'Desktop notification settings and grade-drop alerts',
    defaultConfig: {},
    unique: true,
  },
};

const DEFAULT_WIDGETS = [
  { id: 'default_grades',        type: 'grades',       visible: true, config: { showScore: false, maxCourses: null, showGpa: true } },
  { id: 'default_today_ring',    type: 'today_ring',   visible: true, config: { showLegend: true } },
  { id: 'default_quick_stats',   type: 'quick_stats',  visible: true, config: { showMissing: false, showDueSoon: false, showGpa: true, showTodos: true } },
  { id: 'default_due_soon',      type: 'due_soon',     visible: true, config: {} },
  { id: 'default_missing_work',  type: 'missing_work', visible: true, config: {} },
  { id: 'default_announcements', type: 'announcements',visible: true, config: {} },
  { id: 'default_notifications', type: 'notifications',visible: true, config: {} },
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
    const valid = parsed.filter((w) => WIDGET_PRESETS[w.type]);
    // Migration v1: append any new default widget types not yet in the saved config
    const existingTypes = new Set(valid.map((w) => w.type));
    const migrated = [...valid];
    for (const w of DEFAULT_WIDGETS) {
      if (!existingTypes.has(w.type)) migrated.push({ ...w });
    }
    // Migration v2: remove grade_overview if grades widget is present (merged)
    const hasGrades = new Set(migrated.map((w) => w.type)).has('grades');
    const migrated2 = hasGrades
      ? migrated.filter((w) => w.type !== 'grade_overview')
      : migrated;
    // Migration v3: backfill showGpa onto existing grades configs
    const migrated3 = migrated2.map((w) =>
      w.type === 'grades' && w.config.showGpa === undefined
        ? { ...w, config: { ...w.config, showGpa: true } }
        : w,
    );
    return migrated3;
  } catch {
    return DEFAULT_WIDGETS;
  }
}

export function saveWidgetConfig(widgets) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(widgets));
  } catch {}
}

export function makeWidgetId() {
  return `w_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}
