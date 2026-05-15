import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { canvasApi } from "../api/canvasApi";
import {
  useCachedAsync,
  useHydratedStateFromCache,
} from "../hooks/useCachedAsync";
import { Loading } from "../components/Loading";
import { ErrorBox } from "../components/ErrorBox";
import { Expandable } from "../components/Expandable";
import { WorkloadEstimateControl } from "../components/WorkloadEstimateControl";
import { formatCourseTitle } from "../utils/courseUtils";

const STANDARD_SCALE = [
  { label: "A", value: "A", min: 93 },
  { label: "A-", value: "A-", min: 90 },
  { label: "B+", value: "B+", min: 87 },
  { label: "B", value: "B", min: 83 },
  { label: "B-", value: "B-", min: 80 },
  { label: "C+", value: "C+", min: 77 },
  { label: "C", value: "C", min: 73 },
  { label: "C-", value: "C-", min: 70 },
  { label: "D+", value: "D+", min: 67 },
  { label: "D", value: "D", min: 63 },
  { label: "D-", value: "D-", min: 60 },
  { label: "F", value: "F", min: 0 },
];

const DEFAULT_PASS_THRESHOLD = 70;

function clampPercent(raw, fallback = 0) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, n));
}

function clampPositive(raw, fallback = 0) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, n);
}

function toPct(earned, possible) {
  if (!Number.isFinite(earned) || !Number.isFinite(possible) || possible <= 0)
    return null;
  return (earned / possible) * 100;
}

function fmtPct(v) {
  if (!Number.isFinite(v)) return "-";
  return `${v.toFixed(2)}%`;
}

function fmtPoints(v) {
  if (!Number.isFinite(v)) return "-";
  return v.toFixed(2);
}

function assignmentIdentity(a) {
  return `${a.course_id}:${a.id}`;
}

function hasExplicitPrediction(raw) {
  if (raw == null) return false;
  const s = String(raw).trim();
  if (!s) return false;
  return Number.isFinite(Number(s));
}

function makeThresholdMap(entries) {
  const out = {};
  for (const entry of entries) {
    out[entry.value] = entry.min;
  }
  return out;
}

function getScaleConfig(courseId, scaleByCourse) {
  const stored = scaleByCourse?.[String(courseId)] || {};
  const mode = stored.mode || "standard";

  if (mode === "pass-fail") {
    const passThreshold = clampPercent(
      stored.passThreshold,
      DEFAULT_PASS_THRESHOLD,
    );
    return {
      mode,
      entries: [
        { label: "Pass", value: "P", min: passThreshold },
        { label: "Fail", value: "F", min: 0 },
      ],
      passThreshold,
      thresholds: {},
    };
  }

  if (mode === "custom") {
    const base = makeThresholdMap(STANDARD_SCALE);
    const storedThresholds =
      stored.thresholds && typeof stored.thresholds === "object"
        ? stored.thresholds
        : {};
    const entries = STANDARD_SCALE.map((entry) => ({
      ...entry,
      min:
        entry.value === "F"
          ? 0
          : clampPercent(storedThresholds[entry.value], base[entry.value]),
    }));
    return {
      mode,
      entries,
      passThreshold: DEFAULT_PASS_THRESHOLD,
      thresholds: makeThresholdMap(entries),
    };
  }

  return {
    mode: "standard",
    entries: STANDARD_SCALE,
    passThreshold: DEFAULT_PASS_THRESHOLD,
    thresholds: makeThresholdMap(STANDARD_SCALE),
  };
}


function parseTimestampMs(raw) {
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

function fmtDateTime(raw) {
  const ms = parseTimestampMs(raw);
  if (!Number.isFinite(ms)) return "Unknown";
  return new Date(ms).toLocaleString();
}

function normalizeWeightOverrides(data) {
  const list = Array.isArray(data?.overrides) ? data.overrides : [];
  const out = {};
  for (const item of list) {
    const key = `${item.course_id}:${item.assignment_id}`;
    const weightPoints = Number(item?.weight_points);
    if (!Number.isFinite(weightPoints) || weightPoints <= 0) continue;
    out[key] = {
      weight_points: weightPoints,
      updated_at: item?.updated_at ?? null,
    };
  }
  return out;
}

function normalizeGroupWeightOverrides(data) {
  const list = Array.isArray(data?.overrides) ? data.overrides : [];
  const out = {};
  for (const item of list) {
    const courseId = String(item?.course_id ?? "");
    const groupId = String(item?.group_id ?? "");
    const pct = Number(item?.weight_pct);
    if (!courseId || !groupId || !Number.isFinite(pct)) continue;
    if (!out[courseId]) out[courseId] = {};
    out[courseId][groupId] = pct;
  }
  return out;
}

function normalizeScoreOverrides(raw) {
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object") continue;
    const enabled = !!value.enabled;
    const score = Number(value.score);
    if (!enabled || !Number.isFinite(score)) continue;
    out[key] = { enabled: true, score };
  }
  return out;
}

function normalizeGradeScaleByCourse(raw) {
  const list = Array.isArray(raw?.scales) ? raw.scales : [];
  const out = {};
  for (const row of list) {
    const courseKey = String(row?.course_id || "").trim();
    if (!courseKey) continue;
    const mode =
      row?.mode === "custom" || row?.mode === "pass-fail"
        ? row.mode
        : "standard";
    if (mode === "pass-fail") {
      out[courseKey] = {
        mode,
        passThreshold: clampPercent(row?.pass_threshold, DEFAULT_PASS_THRESHOLD),
      };
      continue;
    }
    if (mode === "custom") {
      const thresholds =
        row?.thresholds && typeof row.thresholds === "object"
          ? row.thresholds
          : {};
      out[courseKey] = {
        mode,
        thresholds,
      };
      continue;
    }
    out[courseKey] = { mode: "standard" };
  }
  return out;
}

function buildStats(
  assignments,
  predictedById,
  weightOverridesById,
  scoreOverridesById,
) {
  let gradedEarned = 0;
  let gradedPossible = 0;
  let predictedEarned = 0;
  let predictedPossible = 0;
  let gradedCount = 0;
  let predictedCount = 0;
  let excludedCount = 0;
  let pendingScoreCount = 0;
  let overrideCount = 0;

  const rows = assignments.map((assignment) => {
    const key = assignmentIdentity(assignment);
    const basePoints = Number(assignment?.points_possible);
    const savedOverride = Number(weightOverridesById?.[key]?.weight_points);
    const effectivePoints =
      Number.isFinite(savedOverride) && savedOverride > 0
        ? savedOverride
        : Number.isFinite(basePoints) && basePoints > 0
          ? basePoints
          : null;
    const hasEffectivePoints =
      Number.isFinite(effectivePoints) && effectivePoints > 0;
    const override = scoreOverridesById?.[key];
    const overrideEnabled = !!override?.enabled;
    const overrideScore = Number(override?.score);
    const score =
      overrideEnabled && Number.isFinite(overrideScore)
        ? overrideScore
        : Number(assignment?.score);
    const hasRawScore = Number.isFinite(score);
    const submitted = assignment?.submitted === true;
    const countedAsGraded =
      hasEffectivePoints && hasRawScore && (submitted || overrideEnabled);
    const pendingScore = hasEffectivePoints && hasRawScore && !submitted;
    const explicitPrediction = predictedById?.[key];
    const predicted =
      hasEffectivePoints &&
      !countedAsGraded &&
      hasExplicitPrediction(explicitPrediction);
    const predictionPct = predicted
      ? clampPercent(explicitPrediction, 0)
      : null;
    const predictionEarned = predicted
      ? (predictionPct / 100) * effectivePoints
      : null;
    const isWeightOverridden =
      Number.isFinite(savedOverride) && savedOverride > 0;

    if (countedAsGraded) {
      gradedEarned += score;
      gradedPossible += effectivePoints;
      gradedCount += 1;
    } else if (predicted) {
      predictedEarned += predictionEarned;
      predictedPossible += effectivePoints;
      predictedCount += 1;
    } else if (hasEffectivePoints) {
      excludedCount += 1;
      if (pendingScore) pendingScoreCount += 1;
    }

    if (isWeightOverridden) overrideCount += 1;

    return {
      assignment,
      key,
      basePoints,
      effectivePoints,
      hasEffectivePoints,
      score,
      hasRawScore,
      submitted,
      countedAsGraded,
      pendingScore,
      predicted,
      predictionPct,
      predictionEarned,
      isWeightOverridden,
      overrideEnabled,
      overrideScore:
        overrideEnabled && Number.isFinite(overrideScore)
          ? overrideScore
          : null,
    };
  });

  return {
    gradedEarned,
    gradedPossible,
    predictedEarned,
    predictedPossible,
    projectedPercent: toPct(
      gradedEarned + predictedEarned,
      gradedPossible + predictedPossible,
    ),
    currentKnownPercent: toPct(gradedEarned, gradedPossible),
    gradedCount,
    predictedCount,
    excludedCount,
    pendingScoreCount,
    overrideCount,
    rows,
  };
}

function InfoTip({ label, text }) {
  const [open, setOpen] = useState(false);

  return (
    <button
      type="button"
      className={`authInfoBubble authInfoBubbleNeutral ${open ? "isOpen" : ""}`}
      aria-label={label}
      aria-expanded={open}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onClick={(e) => {
        e.preventDefault();
        setOpen((prev) => !prev);
      }}
    >
      ?
      <span className="authInfoTooltip" role="tooltip">
        {text}
      </span>
    </button>
  );
}

function Toggle({ checked, onChange, label, disabled = false }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        if (disabled) return;
        onChange(!checked);
      }}
      role="switch"
      aria-checked={checked}
      aria-disabled={disabled}
      aria-label={label}
      title={label}
      className="toggle"
      disabled={disabled}
    >
      <span className={`toggleTrack ${checked ? "on" : "off"}`}>
        <span className={`toggleThumb ${checked ? "on" : "off"}`} />
      </span>
    </button>
  );
}

function AnchoredPopover({
  open,
  onClose,
  anchorEl,
  children,
  width = 420,
  gap = 10,
}) {
  const panelRef = useRef(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (!open) return;

    function recompute() {
      if (!anchorEl) return;
      const rect = anchorEl.getBoundingClientRect();
      const margin = 10;
      const panelHeight = panelRef.current?.offsetHeight || 0;
      const vh = window.innerHeight;

      let left = rect.right + gap;
      if (left + width + margin > window.innerWidth) {
        left = rect.left - gap - width;
      }
      left = Math.max(
        margin,
        Math.min(left, window.innerWidth - width - margin),
      );

      const heightForClamp = panelHeight > 0 ? panelHeight : 40;
      let top = rect.top;
      if (top + heightForClamp + margin > vh) {
        const flippedTop = rect.bottom - heightForClamp;
        if (flippedTop >= margin) {
          top = flippedTop;
        } else {
          top = Math.max(margin, vh - margin - heightForClamp);
        }
      }
      top = Math.max(margin, Math.min(top, vh - margin - heightForClamp));

      setPos({ top, left });
    }

    function onKey(e) {
      if (e.key === "Escape") onClose?.();
    }

    function onMouseDown(e) {
      const panel = panelRef.current;
      const target = e.target;
      if (panel?.contains(target)) return;
      if (anchorEl?.contains(target)) return;
      onClose?.();
    }

    recompute();
    const raf = requestAnimationFrame(recompute);
    let observer = null;
    if (typeof ResizeObserver !== "undefined" && panelRef.current) {
      observer = new ResizeObserver(recompute);
      observer.observe(panelRef.current);
    }
    window.addEventListener("resize", recompute);
    window.addEventListener("scroll", recompute, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onMouseDown);
    return () => {
      cancelAnimationFrame(raf);
      if (observer) observer.disconnect();
      window.removeEventListener("resize", recompute);
      window.removeEventListener("scroll", recompute, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [open, onClose, anchorEl, width, gap]);

  if (!open || !anchorEl) return null;

  return createPortal(
    <div
      ref={panelRef}
      style={{
        position: "fixed",
        top: pos.top,
        left: pos.left,
        width,
        zIndex: 9999,
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

export function GradePerformance({ demoMode = false }) {
  const [selectedCourseId, setSelectedCourseId] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchScope, setSearchScope] = useState("course");
  const [defaultPrediction, setDefaultPrediction] = useState("85");
  const [predictedById, setPredictedById] = useState({});
  const [predictionDraftById, setPredictionDraftById] = useState({});
  const [targetPercent, setTargetPercent] = useState("90");
  const [targetLetter, setTargetLetter] = useState("A-");
  const [selectedNeedAssignmentId, setSelectedNeedAssignmentId] = useState("");
  const [useLetterTarget, setUseLetterTarget] = useState(true);
  const [predictPointsMode, setPredictPointsMode] = useState(false);
  const [useOtherPredictionsInMinNeeded, setUseOtherPredictionsInMinNeeded] =
    useState(true);
  const [finalWeight, setFinalWeight] = useState("20");
  const [predictedFinalExamScore, setPredictedFinalExamScore] = useState("88");
  const [usePredictedInFinalCalc, setUsePredictedInFinalCalc] = useState(false);
  const [showGrades, setShowGrades] = useHydratedStateFromCache(
    "grade-performance:show-grades",
    true,
  );
  const [gradeScaleByCourseLocal, setGradeScaleByCourseLocal] = useHydratedStateFromCache(
    "grade-performance:scale-by-course",
    {},
  );
  const [gradeScaleByCourse, setGradeScaleByCourse] = useState({});
  const [scaleMessage, setScaleMessage] = useState("");
  const [savingWeightKey, setSavingWeightKey] = useState("");
  const [weightMessage, setWeightMessage] = useState("");
  const [scoreOverridesById, setScoreOverridesById] = useHydratedStateFromCache(
    "grade-performance:score-overrides",
    {},
  );
  const [editingKey, setEditingKey] = useState("");
  const [editWeightInput, setEditWeightInput] = useState("");
  const [editingPredictionKey, setEditingPredictionKey] = useState(null);
  const [editUnlockScore, setEditUnlockScore] = useState(false);
  const [editScoreInput, setEditScoreInput] = useState("");
  const [lastProjectionDelta, setLastProjectionDelta] = useState(null);
  const editAnchorRefs = useRef({});

  const summariesQ = useCachedAsync(
    "grade-performance:courses:summary",
    ({ signal }) => canvasApi.getCourseSummaries(3, 5, { signal }),
    { ttlMs: 5 * 60 * 1000 },
  );

  const summaries = Array.isArray(summariesQ.data) ? summariesQ.data : [];

  useEffect(() => {
    if (!summaries.length) return;
    const currentSelected = summaries.some(
      (course) => String(course.id) === String(selectedCourseId),
    );
    if (!selectedCourseId || !currentSelected) {
      setSelectedCourseId(String(summaries[0].id));
    }
  }, [summaries, selectedCourseId]);

  const courseIdsKey = useMemo(
    () =>
      summaries
        .map((course) => course.id)
        .sort((a, b) => a - b)
        .join(","),
    [summaries],
  );

  const allAssignmentsQ = useCachedAsync(
    `grade-performance:all-assignments:${courseIdsKey || "none"}`,
    async ({ signal }) => {
      if (!summaries.length) return [];
      const responses = await Promise.all(
        summaries.map(async (course) => {
          const items = await canvasApi.getCourseAssignmentsIncludingHidden(
            course.id,
            200,
            { signal },
          );
          return (Array.isArray(items) ? items : []).map((assignment) => ({
            ...assignment,
            course_name: assignment?.course_name || course.name,
            course_code: course.course_code || null,
          }));
        }),
      );
      return responses.flat();
    },
    { ttlMs: 5 * 60 * 1000 },
  );

  const allAssignments = Array.isArray(allAssignmentsQ.data)
    ? allAssignmentsQ.data
    : [];

  const overridesQ = useCachedAsync(
    `grade-performance:assignment-weight-overrides:${demoMode ? "demo" : "live"}`,
    ({ signal }) =>
      demoMode
        ? Promise.resolve({ overrides: [] })
        : canvasApi.getAssignmentWeightOverrides({ signal }),
    { ttlMs: 5 * 60 * 1000 },
  );

  const scalePrefsQ = useCachedAsync(
    `grade-performance:scale-preferences:${demoMode ? "demo" : "live"}`,
    ({ signal }) =>
      demoMode
        ? Promise.resolve({ scales: [] })
        : canvasApi.getGradeScalePreferences({ signal }),
    { ttlMs: 5 * 60 * 1000 },
  );

  const groupsQ = useCachedAsync(
    `grade-performance:assignment-groups:${selectedCourseId || "none"}:${demoMode ? "demo" : "live"}`,
    ({ signal }) => {
      if (!selectedCourseId || demoMode) return Promise.resolve({ groups: [] });
      return canvasApi.getCourseAssignmentGroups(selectedCourseId, { signal });
    },
    { ttlMs: 5 * 60 * 1000 },
  );

  const groupOverridesQ = useCachedAsync(
    `grade-performance:assignment-group-weight-overrides:${demoMode ? "demo" : "live"}`,
    ({ signal }) =>
      demoMode
        ? Promise.resolve({ overrides: [] })
        : canvasApi.getAssignmentGroupWeightOverrides({ signal }),
    { ttlMs: 5 * 60 * 1000 },
  );

  const [weightOverridesById, setWeightOverridesById] = useState({});
  const [groupWeightOverrides, setGroupWeightOverrides] = useState({});
  const [savingGroupKey, setSavingGroupKey] = useState("");
  const [groupWeightMessage, setGroupWeightMessage] = useState("");

  useEffect(() => {
    setWeightOverridesById(normalizeWeightOverrides(overridesQ.data));
  }, [overridesQ.data]);

  useEffect(() => {
    setGroupWeightOverrides(normalizeGroupWeightOverrides(groupOverridesQ.data));
  }, [groupOverridesQ.data]);

  useEffect(() => {
    if (demoMode) {
      setGradeScaleByCourse(gradeScaleByCourseLocal || {});
      return;
    }
    setGradeScaleByCourse(normalizeGradeScaleByCourse(scalePrefsQ.data));
  }, [demoMode, gradeScaleByCourseLocal, scalePrefsQ.data]);

  useEffect(() => {
    setScoreOverridesById((prev) => normalizeScoreOverrides(prev));
  }, [setScoreOverridesById]);

  const selectedCourse = useMemo(
    () =>
      summaries.find(
        (course) => String(course.id) === String(selectedCourseId),
      ) ?? null,
    [summaries, selectedCourseId],
  );

  const selectedCourseAssignments = useMemo(
    () =>
      allAssignments.filter(
        (assignment) =>
          String(assignment.course_id) === String(selectedCourseId),
      ),
    [allAssignments, selectedCourseId],
  );

  const scopedAssignments = useMemo(
    () => (searchScope === "all" ? allAssignments : selectedCourseAssignments),
    [searchScope, allAssignments, selectedCourseAssignments],
  );

  const filteredAssignments = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return scopedAssignments;
    return scopedAssignments.filter((assignment) => {
      const name = String(assignment?.name || "").toLowerCase();
      const courseName = String(assignment?.course_name || "").toLowerCase();
      const courseCode = String(assignment?.course_code || "").toLowerCase();
      return (
        name.includes(q) || courseName.includes(q) || courseCode.includes(q)
      );
    });
  }, [scopedAssignments, searchQuery]);

  const recentGradedRows = useMemo(() => {
    return allAssignments
      .map((assignment) => {
        const gradedMs = parseTimestampMs(assignment?.graded_at);
        const score = Number(assignment?.score);
        if (!Number.isFinite(gradedMs) || !Number.isFinite(score)) return null;
        return {
          assignment,
          gradedMs,
          score,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.gradedMs - a.gradedMs)
      .slice(0, 5);
  }, [allAssignments]);

  const stats = useMemo(
    () =>
      buildStats(
        selectedCourseAssignments,
        predictedById,
        weightOverridesById,
        scoreOverridesById,
      ),
    [
      selectedCourseAssignments,
      predictedById,
      weightOverridesById,
      scoreOverridesById,
    ],
  );

  const minNeededCandidates = useMemo(
    () =>
      stats.rows.filter(
        (row) => row.hasEffectivePoints && !row.countedAsGraded,
      ),
    [stats.rows],
  );

  useEffect(() => {
    if (!minNeededCandidates.length) {
      setSelectedNeedAssignmentId("");
      return;
    }
    const hasSelected = minNeededCandidates.some(
      (row) => String(row.assignment.id) === String(selectedNeedAssignmentId),
    );
    if (!selectedNeedAssignmentId || !hasSelected) {
      setSelectedNeedAssignmentId(String(minNeededCandidates[0].assignment.id));
    }
  }, [minNeededCandidates, selectedNeedAssignmentId]);

  const scaleConfig = useMemo(
    () => getScaleConfig(selectedCourseId, gradeScaleByCourse),
    [selectedCourseId, gradeScaleByCourse],
  );

  useEffect(() => {
    if (!scaleConfig.entries.length) return;
    const hasSelected = scaleConfig.entries.some(
      (entry) => entry.value === targetLetter,
    );
    if (!hasSelected) {
      setTargetLetter(scaleConfig.entries[0].value);
    }
  }, [scaleConfig, targetLetter]);

  const needCalculator = useMemo(() => {
    const selected = minNeededCandidates.find(
      (row) => String(row.assignment.id) === String(selectedNeedAssignmentId),
    );
    if (!selected) return null;

    const targetValue = useLetterTarget
      ? (scaleConfig.entries.find((entry) => entry.value === targetLetter)
          ?.min ?? 0)
      : clampPercent(targetPercent, 0);

    const selectedKey = assignmentIdentity(selected.assignment);
    let otherPredictedEarned = 0;
    let otherPredictedPossible = 0;
    let otherPredictedCount = 0;

    for (const row of stats.rows) {
      if (
        !row.hasEffectivePoints ||
        row.countedAsGraded ||
        !row.predicted ||
        row.key === selectedKey
      )
        continue;
      if (useOtherPredictionsInMinNeeded) {
        otherPredictedEarned += row.predictionEarned || 0;
        otherPredictedPossible += row.effectivePoints;
      }
      otherPredictedCount += 1;
    }

    const totalPossible =
      stats.gradedPossible + selected.effectivePoints + otherPredictedPossible;
    if (!Number.isFinite(totalPossible) || totalPossible <= 0) return null;

    const requiredTotalEarned = (targetValue / 100) * totalPossible;
    const requiredOnSelected =
      requiredTotalEarned - stats.gradedEarned - otherPredictedEarned;
    const requiredPctOnSelected =
      (requiredOnSelected / selected.effectivePoints) * 100;

    return {
      targetPercent: targetValue,
      requiredOnSelected,
      requiredPctOnSelected,
      totalPossible,
      selected,
      otherPredictedCount,
    };
  }, [
    minNeededCandidates,
    selectedNeedAssignmentId,
    stats,
    useLetterTarget,
    targetLetter,
    targetPercent,
    scaleConfig,
    useOtherPredictionsInMinNeeded,
  ]);

  const weightedFinalCalc = useMemo(() => {
    const current = usePredictedInFinalCalc
      ? Number(stats?.projectedPercent ?? selectedCourse?.current_score)
      : Number(selectedCourse?.current_score);
    if (!Number.isFinite(current)) return null;

    const w = clampPercent(finalWeight, 0) / 100;
    if (w <= 0 || w >= 1) return null;

    const predictedFinal = clampPercent(predictedFinalExamScore, 0);
    const projectedOverall = current * (1 - w) + predictedFinal * w;

    const targetForWeight = useLetterTarget
      ? (scaleConfig.entries.find((entry) => entry.value === targetLetter)
          ?.min ?? 0)
      : clampPercent(targetPercent, 0);

    const neededOnFinal = (targetForWeight - current * (1 - w)) / w;

    return {
      projectedOverall,
      neededOnFinal,
      weightPct: w * 100,
      targetForWeight,
    };
  }, [
    selectedCourse,
    finalWeight,
    predictedFinalExamScore,
    useLetterTarget,
    targetLetter,
    targetPercent,
    scaleConfig,
    usePredictedInFinalCalc,
    stats,
  ]);

  const filteredOverrideCount = useMemo(
    () =>
      filteredAssignments.filter((assignment) =>
        Number.isFinite(
          Number(
            weightOverridesById?.[assignmentIdentity(assignment)]
              ?.weight_points,
          ),
        ),
      ).length,
    [filteredAssignments, weightOverridesById],
  );

  const scoreOverrideCount = useMemo(
    () => Object.keys(normalizeScoreOverrides(scoreOverridesById)).length,
    [scoreOverridesById],
  );

  const editingAssignment = useMemo(
    () =>
      allAssignments.find(
        (assignment) => assignmentIdentity(assignment) === editingKey,
      ) || null,
    [allAssignments, editingKey],
  );

  const editingRow = useMemo(() => {
    if (!editingAssignment) return null;
    return (
      stats.rows.find((row) => row.key === editingKey) ||
      buildStats(
        [editingAssignment],
        predictedById,
        weightOverridesById,
        scoreOverridesById,
      ).rows[0] ||
      null
    );
  }, [
    editingAssignment,
    editingKey,
    stats.rows,
    predictedById,
    weightOverridesById,
    scoreOverridesById,
  ]);

  const canEditUnlockScore =
    !!editingRow?.countedAsGraded ||
    !!scoreOverridesById?.[editingKey]?.enabled;

  const editingAnchorEl = editingKey
    ? editAnchorRefs.current[editingKey] || null
    : null;

  const displayedProjectedPercent =
    stats.projectedPercent ?? stats.currentKnownPercent;

  const courseGroups = useMemo(() => {
    const raw = Array.isArray(groupsQ.data?.groups) ? groupsQ.data.groups : [];
    return raw
      .slice()
      .sort((a, b) => (a?.position ?? 0) - (b?.position ?? 0));
  }, [groupsQ.data]);

  const selectedCourseGroupOverrides = useMemo(() => {
    if (!selectedCourseId) return {};
    return groupWeightOverrides?.[String(selectedCourseId)] || {};
  }, [groupWeightOverrides, selectedCourseId]);

  const groupWeightedProjection = useMemo(() => {
    if (!courseGroups.length) return null;
    const rowsForCourse = stats.rows.filter(
      (r) => String(r.assignment?.course_id) === String(selectedCourseId),
    );
    if (!rowsForCourse.length) return null;

    const aggByGroup = new Map();
    for (const r of rowsForCourse) {
      const gid = r.assignment?.assignment_group_id;
      if (gid == null) continue;
      if (!r.hasEffectivePoints) continue;
      let agg = aggByGroup.get(String(gid));
      if (!agg) {
        agg = { earned: 0, possible: 0, count: 0 };
        aggByGroup.set(String(gid), agg);
      }
      if (r.countedAsGraded) {
        agg.earned += r.score;
        agg.possible += r.effectivePoints;
        agg.count += 1;
      } else if (r.predicted) {
        agg.earned += r.predictionEarned || 0;
        agg.possible += r.effectivePoints;
        agg.count += 1;
      }
    }

    let weightedSum = 0;
    let totalWeight = 0;
    let usedAnyOverride = false;
    for (const g of courseGroups) {
      const gid = String(g.id);
      const overridePct = selectedCourseGroupOverrides[gid];
      const hasOverride = Number.isFinite(overridePct);
      if (hasOverride) usedAnyOverride = true;
      const canvasWeight = Number(g.group_weight);
      const weight = hasOverride
        ? overridePct
        : Number.isFinite(canvasWeight)
          ? canvasWeight
          : 0;
      if (!Number.isFinite(weight) || weight <= 0) continue;
      const agg = aggByGroup.get(gid);
      if (!agg || agg.possible <= 0) continue;
      const groupPct = (agg.earned / agg.possible) * 100;
      weightedSum += groupPct * weight;
      totalWeight += weight;
    }

    if (totalWeight <= 0) return null;
    return {
      percent: weightedSum / totalWeight,
      usedAnyOverride,
      totalWeight,
    };
  }, [
    courseGroups,
    selectedCourseGroupOverrides,
    selectedCourseId,
    stats.rows,
  ]);

  async function commitGroupWeightOverride(courseId, groupId, raw) {
    if (!courseId || groupId == null) return;
    const cKey = String(courseId);
    const gKey = String(groupId);
    const trimmed = String(raw ?? "").trim();
    setSavingGroupKey(`${cKey}:${gKey}`);
    setGroupWeightMessage("");
    try {
      if (trimmed === "") {
        if (!demoMode) {
          await canvasApi.deleteAssignmentGroupWeightOverride(cKey, gKey);
        }
        setGroupWeightOverrides((prev) => {
          const next = { ...(prev || {}) };
          if (next[cKey]) {
            const copy = { ...next[cKey] };
            delete copy[gKey];
            if (Object.keys(copy).length === 0) {
              delete next[cKey];
            } else {
              next[cKey] = copy;
            }
          }
          return next;
        });
        setGroupWeightMessage("Reset to Canvas weight.");
      } else {
        const pct = Number(trimmed);
        if (!Number.isFinite(pct) || pct < 0) {
          setGroupWeightMessage("Enter a non-negative number.");
          return;
        }
        if (!demoMode) {
          await canvasApi.upsertAssignmentGroupWeightOverride(cKey, gKey, pct);
        }
        setGroupWeightOverrides((prev) => {
          const next = { ...(prev || {}) };
          next[cKey] = { ...(next[cKey] || {}), [gKey]: pct };
          return next;
        });
        setGroupWeightMessage("Saved custom group weight.");
      }
    } catch (err) {
      setGroupWeightMessage(
        err?.message ? `Could not save: ${err.message}` : "Could not save.",
      );
    } finally {
      setSavingGroupKey("");
    }
  }

  useEffect(() => {
    setLastProjectionDelta(null);
  }, [selectedCourseId]);

  function displayGrade(text) {
    return showGrades ? text : "Hidden";
  }

  function gradeSensitiveBadgeClass(classWhenShown) {
    return `badge ${showGrades ? classWhenShown : "badgeNeutral"}`;
  }

  function computeDisplayedProjectedPercent(
    assignments,
    nextPredictedById,
    nextWeightOverridesById,
    nextScoreOverridesById,
  ) {
    const nextStats = buildStats(
      assignments,
      nextPredictedById,
      nextWeightOverridesById,
      nextScoreOverridesById,
    );
    return nextStats.projectedPercent ?? nextStats.currentKnownPercent;
  }

  function recordProjectionDelta(
    nextPredictedById,
    nextWeightOverridesById = weightOverridesById,
    nextScoreOverridesById = scoreOverridesById,
  ) {
    const before = computeDisplayedProjectedPercent(
      selectedCourseAssignments,
      predictedById,
      weightOverridesById,
      scoreOverridesById,
    );
    const after = computeDisplayedProjectedPercent(
      selectedCourseAssignments,
      nextPredictedById,
      nextWeightOverridesById,
      nextScoreOverridesById,
    );

    if (!Number.isFinite(before) || !Number.isFinite(after)) {
      setLastProjectionDelta(null);
      return;
    }

    setLastProjectionDelta(after - before);
  }

  function getPredictionDraftValue(key) {
    if (Object.prototype.hasOwnProperty.call(predictionDraftById, key)) {
      return predictionDraftById[key];
    }
    return predictedById[key] ?? "";
  }

  function commitPredictionDraft(key, rawValue = getPredictionDraftValue(key)) {
    const trimmed = String(rawValue ?? "").trim();
    const nextPredicted = { ...(predictedById || {}) };

    if (!trimmed) {
      delete nextPredicted[key];
    } else if (Number.isFinite(Number(trimmed))) {
      nextPredicted[key] = trimmed;
    } else {
      return;
    }

    setPredictedById(nextPredicted);
    setPredictionDraftById((prev) => {
      const next = { ...(prev || {}) };
      delete next[key];
      return next;
    });
    recordProjectionDelta(nextPredicted);
  }

  function updateSelectedCourseScale(updater) {
    if (!selectedCourseId) return;
    const courseKey = String(selectedCourseId);
    const current = gradeScaleByCourse?.[courseKey] || { mode: "standard" };
    const nextConfig =
      typeof updater === "function" ? updater(current) : updater;

    setGradeScaleByCourse((prev) => ({
      ...(prev || {}),
      [courseKey]: nextConfig,
    }));

    if (demoMode) {
      setGradeScaleByCourseLocal((prev) => ({
        ...(prev || {}),
        [courseKey]: nextConfig,
      }));
      return;
    }

    setScaleMessage("");
    canvasApi
      .upsertGradeScalePreference(selectedCourseId, {
        mode: nextConfig?.mode || "standard",
        thresholds:
          nextConfig?.mode === "custom" ? nextConfig?.thresholds || {} : null,
        pass_threshold:
          nextConfig?.mode === "pass-fail"
            ? clampPercent(nextConfig?.passThreshold, DEFAULT_PASS_THRESHOLD)
            : null,
      })
      .catch((error) => {
        setScaleMessage(
          error?.message || "Failed to save grade scale preference.",
        );
      });
  }

  function setScaleMode(mode) {
    updateSelectedCourseScale((current) => {
      if (mode === "pass-fail") {
        return {
          mode,
          passThreshold: clampPercent(
            current?.passThreshold,
            DEFAULT_PASS_THRESHOLD,
          ),
        };
      }
      if (mode === "custom") {
        return {
          mode,
          thresholds:
            current?.thresholds && typeof current.thresholds === "object"
              ? current.thresholds
              : makeThresholdMap(STANDARD_SCALE),
        };
      }
      return { mode: "standard" };
    });
  }

  function updateCustomThreshold(label, value) {
    updateSelectedCourseScale((current) => ({
      mode: "custom",
      thresholds: {
        ...(current?.thresholds || makeThresholdMap(STANDARD_SCALE)),
        [label]: clampPercent(
          value,
          makeThresholdMap(STANDARD_SCALE)[label] ?? 0,
        ),
      },
    }));
  }

  function updatePassThreshold(value) {
    updateSelectedCourseScale((current) => ({
      mode: "pass-fail",
      passThreshold: clampPercent(
        value,
        current?.passThreshold ?? DEFAULT_PASS_THRESHOLD,
      ),
    }));
  }

  function applyDefaultPredictionToVisible() {
    const defaultPred = clampPercent(defaultPrediction, 85);
    const next = { ...predictedById };
    const nextDrafts = { ...(predictionDraftById || {}) };
    for (const assignment of filteredAssignments) {
      const key = assignmentIdentity(assignment);
      const effectiveWeight = Number(weightOverridesById?.[key]?.weight_points);
      const basePoints = Number(assignment?.points_possible);
      const hasEffectivePoints =
        (Number.isFinite(effectiveWeight) && effectiveWeight > 0) ||
        (Number.isFinite(basePoints) && basePoints > 0);
      const submitted = assignment?.submitted === true;
      const hasScore = Number.isFinite(Number(assignment?.score));
      if (!hasEffectivePoints || (submitted && hasScore)) continue;
      next[key] = String(defaultPred);
      delete nextDrafts[key];
    }
    setPredictedById(next);
    setPredictionDraftById(nextDrafts);
    recordProjectionDelta(next);
  }

  function clearVisiblePredictions() {
    const next = { ...predictedById };
    const nextDrafts = { ...(predictionDraftById || {}) };
    const nextScoreOverrides = { ...(scoreOverridesById || {}) };
    for (const assignment of filteredAssignments) {
      const key = assignmentIdentity(assignment);
      delete next[key];
      delete nextDrafts[key];
      delete nextScoreOverrides[key];
    }
    setPredictedById(next);
    setPredictionDraftById(nextDrafts);
    setScoreOverridesById(nextScoreOverrides);
    recordProjectionDelta(next, weightOverridesById, nextScoreOverrides);
  }

  function applyDefaultToUnpredicted() {
    const defaultPred = clampPercent(defaultPrediction, 85);
    const next = { ...predictedById };
    const nextDrafts = { ...(predictionDraftById || {}) };
    for (const assignment of filteredAssignments) {
      const key = assignmentIdentity(assignment);
      if (next[key] != null) continue;
      const effectiveWeight = Number(weightOverridesById?.[key]?.weight_points);
      const basePoints = Number(assignment?.points_possible);
      const hasEffectivePoints =
        (Number.isFinite(effectiveWeight) && effectiveWeight > 0) ||
        (Number.isFinite(basePoints) && basePoints > 0);
      const submitted = assignment?.submitted === true;
      const hasScore = Number.isFinite(Number(assignment?.score));
      if (!hasEffectivePoints || (submitted && hasScore)) continue;
      next[key] = String(defaultPred);
      delete nextDrafts[key];
    }
    setPredictedById(next);
    setPredictionDraftById(nextDrafts);
    recordProjectionDelta(next);
  }

  function applyActualScoresToVisible() {
    const next = { ...predictedById };
    const nextDrafts = { ...(predictionDraftById || {}) };
    for (const assignment of filteredAssignments) {
      const key = assignmentIdentity(assignment);
      const pct = toPct(assignment?.score, assignment?.points_possible);
      if (pct == null) continue;
      next[key] = String(pct);
      delete nextDrafts[key];
    }
    setPredictedById(next);
    setPredictionDraftById(nextDrafts);
    recordProjectionDelta(next);
  }

  function getWeightInputValue(assignment) {
    const key = assignmentIdentity(assignment);
    const saved = Number(weightOverridesById?.[key]?.weight_points);
    if (Number.isFinite(saved) && saved > 0) return String(saved);
    const base = Number(assignment?.points_possible);
    if (Number.isFinite(base) && base > 0) return String(base);
    return "";
  }

  function getNextWeightOverridesForInput(
    assignment,
    rawInput,
    source = weightOverridesById,
  ) {
    const key = assignmentIdentity(assignment);
    const nextWeightOverrides = { ...(source || {}) };
    const trimmed = String(rawInput || "").trim();
    const base = Number(assignment?.points_possible);
    const baseValid = Number.isFinite(base) && base > 0;
    const nextWeight = clampPositive(trimmed, NaN);

    if (!trimmed || !Number.isFinite(nextWeight) || nextWeight <= 0) {
      delete nextWeightOverrides[key];
      return nextWeightOverrides;
    }

    if (baseValid && Math.abs(nextWeight - base) < 1e-9) {
      delete nextWeightOverrides[key];
      return nextWeightOverrides;
    }

    nextWeightOverrides[key] = {
      weight_points: nextWeight,
      updated_at: new Date().toISOString(),
    };
    return nextWeightOverrides;
  }

  function openEditPopup(assignment) {
    const key = assignmentIdentity(assignment);
    const row =
      stats.rows.find((item) => item.key === key) ||
      buildStats(
        [assignment],
        predictedById,
        weightOverridesById,
        scoreOverridesById,
      ).rows[0];
    const scoreOverride = scoreOverridesById?.[key];
    const canUnlockScore = !!row?.countedAsGraded || !!scoreOverride?.enabled;
    setEditingKey(key);
    setEditWeightInput(getWeightInputValue(assignment));
    setEditUnlockScore(canUnlockScore && !!scoreOverride?.enabled);
    setEditScoreInput(
      scoreOverride?.enabled
        ? String(scoreOverride.score)
        : Number.isFinite(Number(row?.score))
          ? String(row.score)
          : Number.isFinite(Number(assignment?.score))
            ? String(assignment.score)
            : "",
    );
  }

  function closeEditPopup() {
    setEditingKey("");
    setEditWeightInput("");
    setEditUnlockScore(false);
    setEditScoreInput("");
  }

  async function removeWeightOverride(assignment) {
    const key = assignmentIdentity(assignment);
    setSavingWeightKey(key);
    try {
      await canvasApi.deleteAssignmentWeightOverride(
        assignment.course_id,
        assignment.id,
      );
      const nextWeightOverridesById = { ...weightOverridesById };
      delete nextWeightOverridesById[key];
      setWeightOverridesById(nextWeightOverridesById);
      recordProjectionDelta(
        predictedById,
        nextWeightOverridesById,
        scoreOverridesById,
      );
      setWeightMessage(`Reset ${assignment.name} to Canvas weight.`);
    } catch (error) {
      setWeightMessage(error?.message || "Failed to reset weight override.");
    } finally {
      setSavingWeightKey("");
    }
  }

  async function applyWeightValue(assignment, rawInput) {
    const key = assignmentIdentity(assignment);
    const trimmed = String(rawInput || "").trim();
    const saved = Number(weightOverridesById?.[key]?.weight_points);
    const base = Number(assignment?.points_possible);
    const baseValid = Number.isFinite(base) && base > 0;

    if (!trimmed) {
      if (Number.isFinite(saved) && saved > 0) {
        await removeWeightOverride(assignment);
      }
      return;
    }

    const nextWeight = clampPositive(trimmed, NaN);
    if (!Number.isFinite(nextWeight) || nextWeight <= 0) {
      setWeightMessage("Weight/points must be greater than 0.");
      return;
    }

    if (baseValid && Math.abs(nextWeight - base) < 1e-9) {
      if (Number.isFinite(saved) && saved > 0) {
        await removeWeightOverride(assignment);
      }
      return;
    }

    if (
      Number.isFinite(saved) &&
      saved > 0 &&
      Math.abs(saved - nextWeight) < 1e-9
    ) {
      return;
    }

    setSavingWeightKey(key);
    try {
      await canvasApi.upsertAssignmentWeightOverride(
        assignment.course_id,
        assignment.id,
        nextWeight,
      );
      const nextWeightOverridesById = {
        ...weightOverridesById,
        [key]: {
          weight_points: nextWeight,
          updated_at: new Date().toISOString(),
        },
      };
      setWeightOverridesById(nextWeightOverridesById);
      recordProjectionDelta(
        predictedById,
        nextWeightOverridesById,
        scoreOverridesById,
      );
      setWeightMessage(`Saved custom weight for ${assignment.name}.`);
    } catch (error) {
      setWeightMessage(error?.message || "Failed to save weight override.");
    } finally {
      setSavingWeightKey("");
    }
  }

  async function saveEditPopup() {
    if (!editingKey) return;
    const assignment = editingAssignment;
    if (!assignment) return;
    if (editUnlockScore && !canEditUnlockScore) {
      setWeightMessage(
        "Score override can only be enabled for assignments that already have a graded score.",
      );
      return;
    }
    const before = computeDisplayedProjectedPercent(
      selectedCourseAssignments,
      predictedById,
      weightOverridesById,
      scoreOverridesById,
    );
    const nextWeightOverrides = getNextWeightOverridesForInput(
      assignment,
      editWeightInput,
      weightOverridesById,
    );

    setWeightMessage("");
    await applyWeightValue(assignment, editWeightInput);

    if (editUnlockScore) {
      const nextScore = Number(editScoreInput);
      if (Number.isFinite(nextScore)) {
        const nextScoreOverrides = {
          ...(scoreOverridesById || {}),
          [editingKey]: {
            enabled: true,
            score: nextScore,
          },
        };
        setScoreOverridesById(nextScoreOverrides);
        const after = computeDisplayedProjectedPercent(
          selectedCourseAssignments,
          predictedById,
          nextWeightOverrides,
          nextScoreOverrides,
        );
        setLastProjectionDelta(
          Number.isFinite(before) && Number.isFinite(after)
            ? after - before
            : null,
        );
      } else {
        setWeightMessage("Unlock score is enabled, but score must be numeric.");
        return;
      }
    } else {
      const nextScoreOverrides = { ...(scoreOverridesById || {}) };
      delete nextScoreOverrides[editingKey];
      setScoreOverridesById(nextScoreOverrides);
      const after = computeDisplayedProjectedPercent(
        selectedCourseAssignments,
        predictedById,
        nextWeightOverrides,
        nextScoreOverrides,
      );
      setLastProjectionDelta(
        Number.isFinite(before) && Number.isFinite(after)
          ? after - before
          : null,
      );
    }

    closeEditPopup();
  }

  async function restoreEditDefaults() {
    if (!editingKey) return;
    const assignment = editingAssignment;
    if (!assignment) return;
    const before = computeDisplayedProjectedPercent(
      selectedCourseAssignments,
      predictedById,
      weightOverridesById,
      scoreOverridesById,
    );

    await removeWeightOverride(assignment);

    const nextScoreOverrides = { ...(scoreOverridesById || {}) };
    delete nextScoreOverrides[editingKey];
    setScoreOverridesById(nextScoreOverrides);

    const nextPredicted = { ...(predictedById || {}) };
    delete nextPredicted[editingKey];
    setPredictedById(nextPredicted);
    setPredictionDraftById((prev) => {
      const next = { ...(prev || {}) };
      delete next[editingKey];
      return next;
    });
    const nextWeightOverrides = getNextWeightOverridesForInput(
      assignment,
      "",
      weightOverridesById,
    );
    const after = computeDisplayedProjectedPercent(
      selectedCourseAssignments,
      nextPredicted,
      nextWeightOverrides,
      nextScoreOverrides,
    );
    setLastProjectionDelta(
      Number.isFinite(before) && Number.isFinite(after) ? after - before : null,
    );

    setWeightMessage(`Restored defaults for ${assignment.name}.`);
    closeEditPopup();
  }

  function isAuthOrTokenError(error) {
    return !!(
      error &&
      (error.status === 401 || error.status === 403 || error.needsToken)
    );
  }

  const summariesErrorDisplay =
    summariesQ.error && !isAuthOrTokenError(summariesQ.error)
      ? summariesQ.error
      : null;
  const allAssignmentsErrorDisplay =
    allAssignmentsQ.error && !isAuthOrTokenError(allAssignmentsQ.error)
      ? allAssignmentsQ.error
      : null;
  const overridesErrorDisplay =
    overridesQ.error && !isAuthOrTokenError(overridesQ.error)
      ? overridesQ.error
      : null;
  const scalePrefsErrorDisplay =
    scalePrefsQ.error && !isAuthOrTokenError(scalePrefsQ.error)
      ? scalePrefsQ.error
      : null;

  if (
    (summariesQ.loading && !summaries.length) ||
    (allAssignmentsQ.loading && !allAssignments.length && summaries.length > 0)
  ) {
    return <Loading label="Loading grade tools..." />;
  }

  if (summariesErrorDisplay && !summaries.length)
    return <ErrorBox error={summariesErrorDisplay} />;
  if (
    allAssignmentsErrorDisplay &&
    !allAssignments.length &&
    summaries.length > 0
  )
    return <ErrorBox error={allAssignmentsErrorDisplay} />;

  return (
    <div className="stack">
      <div className="card gradeCalcCard">
        <div className="cardBody stack">
          <div className="gradeCalcHeaderRow">
            <div className="stack" style={{ gap: 6 }}>
              <div className="gradeCalcTitleRow">
                <div className="h2">Final Grade Calculator</div>
                <InfoTip
                  label="How this works"
                  text="This tab treats an assignment as graded only when it has both a score and a submitted state from Canvas. Ungraded or unsubmitted work is excluded unless you explicitly add a prediction."
                />
              </div>
              <div className="muted">
                Select a class for course-specific calculators. Search can be
                scoped to that class or expanded across all classes.
              </div>
            </div>

            <div className="toggleRow gradeCalcHeaderToggle">
              <span className="muted">Hide all grades</span>
              <Toggle
                checked={!showGrades}
                onChange={(nextHidden) => setShowGrades(!nextHidden)}
                label={showGrades ? "Hide grades" : "Show grades"}
              />
            </div>
          </div>

          <div className="h3">Course Setup</div>
          <div className="gradeCalcControls">
            <label className="gradeCalcField gradeCalcFieldWide">
              <span className="gradeCalcFieldLabel">
                <span className="muted">Class</span>
                <InfoTip
                  label="Class selector help"
                  text="The weighted-final, target, and minimum-needed calculators below all use this selected class."
                />
              </span>
              <div className="row" style={{ alignItems: "center", gap: 8 }}>
                <select
                  className="select"
                  style={{ flex: "1 1 auto" }}
                  value={selectedCourseId}
                  onChange={(e) => setSelectedCourseId(e.target.value)}
                >
                  {summaries.map((course) => (
                    <option key={course.id} value={String(course.id)}>
                      {formatCourseTitle(course.name)}
                    </option>
                  ))}
                </select>
                {selectedCourse?.html_url ? (
                  <a
                    className="btn"
                    href={`${selectedCourse.html_url}/grades`}
                    target="_blank"
                    rel="noreferrer"
                    title="Open course grades in Canvas"
                    style={{ flexShrink: 0, whiteSpace: "nowrap" }}
                  >
                    View Grades
                  </a>
                ) : null}
              </div>
            </label>
          </div>

          <div className="rowWrap">
            <span className="badge badgeNeutral">
              Canvas current score:{" "}
              {displayGrade(fmtPct(Number(selectedCourse?.current_score)))}
            </span>
            <span className="badge badgeNeutral">
              Canvas current letter:{" "}
              {displayGrade(selectedCourse?.current_grade || "-")}
            </span>
            <span className="badge badgeNeutral">
              Known graded avg:{" "}
              {displayGrade(fmtPct(stats.currentKnownPercent))}
            </span>
          </div>

          <div className="muted gradeCalcBasis">
            Calculation basis: {stats.gradedCount} submitted and scored items (
            {fmtPoints(stats.gradedPossible)} effective pts),{" "}
            {stats.predictedCount} predicted items (
            {fmtPoints(stats.predictedPossible)} effective pts),{" "}
            {stats.excludedCount} ungraded or unsubmitted items excluded,{" "}
            {stats.pendingScoreCount} score-bearing but unsubmitted items
            excluded, {stats.overrideCount} custom weight overrides active in
            this class.
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div className="h3" style={{ margin: 0 }}>
              Target Settings
            </div>
            <InfoTip
              label="Target settings help"
              text="Choose a letter-grade or numeric target, then adjust the grade scale if this class uses non-standard thresholds or pass/fail grading."
            />
          </div>

          <div className="gradeCalcControls">
            <label className="gradeCalcField">
              <span className="muted">Target type</span>
              <select
                className="select"
                value={useLetterTarget ? "letter" : "percent"}
                onChange={(e) =>
                  setUseLetterTarget(e.target.value === "letter")
                }
              >
                <option value="letter">Letter grade</option>
                <option value="percent">Percent score</option>
              </select>
            </label>

            <label className="gradeCalcField">
              <span className="muted">Grade scale</span>
              <select
                className="select"
                value={scaleConfig.mode}
                onChange={(e) => setScaleMode(e.target.value)}
              >
                <option value="standard">Standard +/- scale</option>
                <option value="custom">Custom thresholds</option>
                <option value="pass-fail">Pass / Fail</option>
              </select>
            </label>

            {useLetterTarget ? (
              <label className="gradeCalcField">
                <span className="muted">Target grade</span>
                <select
                  className="select"
                  value={targetLetter}
                  onChange={(e) => setTargetLetter(e.target.value)}
                >
                  {scaleConfig.entries.map((entry) => (
                    <option key={entry.value} value={entry.value}>
                      {entry.label} ({entry.min}%)
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <label className="gradeCalcField">
                <span className="muted">Target percent</span>
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={targetPercent}
                  onChange={(e) => setTargetPercent(e.target.value)}
                />
              </label>
            )}
          </div>

          {scaleConfig.mode === "custom" ? (
            <div className="gradeScaleGrid">
              {STANDARD_SCALE.filter((entry) => entry.value !== "F").map(
                (entry) => (
                  <label key={entry.value} className="gradeCalcField">
                    <span className="muted">{entry.label} min %</span>
                    <input
                      type="number"
                      min="0"
                      max="100"
                      value={scaleConfig.thresholds[entry.value] ?? entry.min}
                      onChange={(e) =>
                        updateCustomThreshold(entry.value, e.target.value)
                      }
                    />
                  </label>
                ),
              )}
            </div>
          ) : null}

          {scaleConfig.mode === "pass-fail" ? (
            <div className="gradeCalcControls">
              <label className="gradeCalcField">
                <span className="muted">Pass threshold (%)</span>
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={scaleConfig.passThreshold}
                  onChange={(e) => updatePassThreshold(e.target.value)}
                />
              </label>
            </div>
          ) : null}

          <Expandable
            title="Custom Group Weights"
            subtitle={
              courseGroups.length
                ? `${courseGroups.length} Canvas group${courseGroups.length === 1 ? "" : "s"}${
                    Object.keys(selectedCourseGroupOverrides).length
                      ? ` • ${Object.keys(selectedCourseGroupOverrides).length} overridden`
                      : ""
                  }`
                : groupsQ.loading
                  ? "Loading groups..."
                  : "No groups available"
            }
          >
            {groupsQ.error ? (
              <div className="muted">
                Could not load assignment groups for this course.
              </div>
            ) : courseGroups.length === 0 ? (
              <div className="muted">
                {demoMode
                  ? "Custom group weights are not available in demo mode."
                  : "Canvas did not return assignment groups for this course."}
              </div>
            ) : (
              <>
                <div className="muted gradeCalcBasis">
                  Override the Canvas-reported weight (%) for any group. Leave
                  blank to use Canvas&apos;s value.
                </div>
                <ul className="gradeCalcList">
                  {courseGroups.map((g) => {
                    const gKey = String(g.id);
                    const overrideVal = selectedCourseGroupOverrides[gKey];
                    const hasOverride = Number.isFinite(overrideVal);
                    const canvasWeight = Number(g.group_weight);
                    const isSaving =
                      savingGroupKey === `${String(selectedCourseId)}:${gKey}`;
                    return (
                      <li key={gKey} className="gradeCalcListItem">
                        <div className="gradeCalcListMain">
                          <div className="gradeCalcItemTitleRow">
                            <span className="gradeCalcItemTitle">{g.name}</span>
                            {hasOverride ? (
                              <span className="badge badgeNeutral">
                                Custom weight
                              </span>
                            ) : null}
                          </div>
                          <div className="muted">
                            Canvas weight:{" "}
                            {Number.isFinite(canvasWeight)
                              ? `${canvasWeight}%`
                              : "Not set"}
                          </div>
                        </div>
                        <div className="gradeCalcListControls">
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            defaultValue={hasOverride ? overrideVal : ""}
                            placeholder={
                              Number.isFinite(canvasWeight)
                                ? String(canvasWeight)
                                : ""
                            }
                            onBlur={(e) =>
                              commitGroupWeightOverride(
                                selectedCourseId,
                                g.id,
                                e.currentTarget.value,
                              )
                            }
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                commitGroupWeightOverride(
                                  selectedCourseId,
                                  g.id,
                                  e.currentTarget.value,
                                );
                                e.currentTarget.blur();
                              }
                            }}
                            disabled={isSaving}
                          />
                          <span className="muted">%</span>
                          {hasOverride ? (
                            <button
                              type="button"
                              className="btn"
                              onClick={() =>
                                commitGroupWeightOverride(
                                  selectedCourseId,
                                  g.id,
                                  "",
                                )
                              }
                              disabled={isSaving}
                              title="Reset to Canvas weight"
                            >
                              Reset
                            </button>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
                {groupWeightMessage ? (
                  <div className="muted">{groupWeightMessage}</div>
                ) : null}
              </>
            )}
          </Expandable>

          <Expandable
            title="Recently Graded (Last 5)"
            subtitle={
              recentGradedRows.length
                ? `${recentGradedRows.length} recently graded assignment${recentGradedRows.length === 1 ? "" : "s"}`
                : "No graded assignments found yet"
            }
          >
            {recentGradedRows.length === 0 ? (
              <div className="muted">
                No graded assignments were found yet.
              </div>
            ) : (
              <ul className="gradeCalcList recentGradeList">
                {recentGradedRows.map(({ assignment, gradedMs, score }) => (
                  <li
                    key={`${assignmentIdentity(assignment)}:${gradedMs}`}
                    className="gradeCalcListItem recentGradeItem"
                  >
                    <div className="gradeCalcListMain recentGradeMain">
                      <div className="gradeCalcItemTitle">{assignment.name}</div>
                      <div className="muted recentGradeCourse">
                        {formatCourseTitle(assignment?.course_name)}
                      </div>
                      <div className="recentGradeMeta muted">
                        <span>Graded {fmtDateTime(assignment?.graded_at)}</span>
                        <span>
                          Score {displayGrade(fmtPoints(score))}
                          {Number.isFinite(Number(assignment?.points_possible))
                            ? ` / ${displayGrade(fmtPoints(Number(assignment.points_possible)))}`
                            : ""}
                        </span>
                      </div>
                    </div>
                    {assignment?.html_url ? (
                      <div className="recentGradeActions">
                        <a
                          className="btn"
                          href={assignment.html_url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          View in Canvas
                        </a>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Expandable>

          {scaleMessage ? <div className="authHint">{scaleMessage}</div> : null}
          {scalePrefsErrorDisplay ? <ErrorBox error={scalePrefsErrorDisplay} /> : null}
        </div>
      </div>

      <AnchoredPopover
        open={!!editingKey && !!editingAnchorEl}
        onClose={closeEditPopup}
        anchorEl={editingAnchorEl}
      >
        <div className="effortPopover gradeCalcPopover">
          <div className="effortPopoverHeader">
            <div>
              <div className="h3" style={{ margin: 0 }}>
                Edit Assignment
              </div>
              <div className="muted" style={{ marginTop: 4 }}>
                {editingAssignment?.name || "Assignment"}
              </div>
            </div>
            <button
              type="button"
              className="effortCloseBtn"
              onClick={closeEditPopup}
              aria-label="Close edit popup"
            >
              ×
            </button>
          </div>

          <div className="effortPopoverBody">
            <label className="gradeCalcField">
              <span className="muted">Weight / pts override</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={editWeightInput}
                onChange={(e) => setEditWeightInput(e.target.value)}
                placeholder="Use Canvas default"
              />
              <div className="muted">
                Leave blank or use the Canvas value to clear override.
              </div>
            </label>

            <div className="toggleRow">
              <span className="muted">Modify locked score</span>
              <Toggle
                checked={editUnlockScore}
                onChange={setEditUnlockScore}
                label={
                  editUnlockScore
                    ? "Disable score override"
                    : "Enable score override"
                }
                disabled={!canEditUnlockScore}
              />
            </div>

            {!canEditUnlockScore ? (
              <div className="muted">
                Score override is only available for assignments that already
                have a graded score.
              </div>
            ) : null}

            {editUnlockScore ? (
              <label className="gradeCalcField">
                <span className="muted">Override score</span>
                <input
                  type="number"
                  step="0.01"
                  value={editScoreInput}
                  onChange={(e) => setEditScoreInput(e.target.value)}
                  placeholder="Enter adjusted score"
                />
                <div className="muted">
                  This score is local to this tab and updates grade
                  bubbles/calculations.
                </div>
              </label>
            ) : null}

            <div className="gradeCalcPopoverActions">
              <button type="button" className="btn" onClick={saveEditPopup}>
                Save
              </button>
              <button
                type="button"
                className="btn"
                onClick={restoreEditDefaults}
              >
                Restore Defaults
              </button>
              <button type="button" className="btn" onClick={closeEditPopup}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      </AnchoredPopover>

      <div className="card gradeCalcCard">
        <div className="cardBody stack">
          <div className="gradeCalcSectionHeading">
            <div className="h3">Weighted Final Exam Calculator</div>
            <InfoTip
              label="Weighted final help"
              text="Use this when your syllabus has a specific final-exam weight. This block uses the selected class's Canvas current score plus your manual final-exam prediction."
            />
          </div>

          <div className="gradeCalcControls">
            <label className="gradeCalcField">
              <span className="muted">Final exam weight (%)</span>
              <input
                type="number"
                min="1"
                max="99"
                value={finalWeight}
                onChange={(e) => setFinalWeight(e.target.value)}
              />
            </label>

            <label className="gradeCalcField">
              <span className="muted">Predicted final score (%)</span>
              <input
                type="number"
                min="0"
                max="100"
                value={predictedFinalExamScore}
                onChange={(e) => setPredictedFinalExamScore(e.target.value)}
              />
            </label>
          </div>

          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <input
              type="checkbox"
              className="themeCheckbox"
              checked={usePredictedInFinalCalc}
              onChange={(e) => setUsePredictedInFinalCalc(e.target.checked)}
            />
            <span className="muted" style={{ fontSize: "var(--fontSm)" }}>
              Use predicted scores as current grade
            </span>
          </label>

          {weightedFinalCalc ? (
            <>
              <div className="rowWrap">
                <span className={gradeSensitiveBadgeClass("badgeSuccess")}>
                  Projected overall:{" "}
                  {displayGrade(fmtPct(weightedFinalCalc.projectedOverall))}
                </span>
                <span className={gradeSensitiveBadgeClass("badgeWarn")}>
                  Minimum final score for target:{" "}
                  {displayGrade(fmtPct(weightedFinalCalc.neededOnFinal))}
                </span>
                <span className="badge badgeNeutral">
                  Weight used: {fmtPct(weightedFinalCalc.weightPct)}
                </span>
              </div>
              <div className="muted gradeCalcBasis">
                Calculation basis:{" "}
                {usePredictedInFinalCalc
                  ? "Projected grade (Canvas scores + your predictions)"
                  : "Canvas current score for the selected class"}{" "}
                plus a manual final-exam weight of{" "}
                {fmtPct(weightedFinalCalc.weightPct)}.
              </div>
            </>
          ) : (
            <div className="muted">
              Weighted final calculation needs a Canvas current course score and
              a final weight between 1% and 99%.
            </div>
          )}
        </div>
      </div>

      <div className="card gradeCalcCard">
        <div className="cardBody stack">
          <div className="gradeCalcSectionHeading">
            <div className="h3">Assignment Search + Prediction</div>
            <InfoTip
              label="Search and prediction help"
              text="Search within the selected class or across all classes. You can add predictions for ungraded items and save custom effective weights/points for any assignment."
            />
          </div>

          <div className="gradeCalcControls gradeCalcSearchControls">
            <div className="gradeCalcInlineControl gradeCalcInlineControlGroup">
              <span className="muted gradeCalcInlineHeading">Search scope</span>
              <div className="gradeCalcScopeToggleRow">
                <span
                  className={`muted gradeCalcInlineValue ${searchScope === "course" ? "gradeCalcScopeLabelActive" : ""}`}
                >
                  Selected class
                </span>
                <Toggle
                  checked={searchScope === "all"}
                  onChange={(checked) =>
                    setSearchScope(checked ? "all" : "course")
                  }
                  label={
                    searchScope === "all"
                      ? "Searching all classes"
                      : "Searching selected class only"
                  }
                />
                <span
                  className={`muted gradeCalcInlineValue ${searchScope === "all" ? "gradeCalcScopeLabelActive" : ""}`}
                >
                  All classes
                </span>
              </div>
            </div>

            <div className="gradeCalcInlineControl gradeCalcInlineControlGroup">
              <span className="muted gradeCalcInlineHeading">Predict in</span>
              <div className="gradeCalcScopeToggleRow">
                <span
                  className={`muted gradeCalcInlineValue ${!predictPointsMode ? "gradeCalcScopeLabelActive" : ""}`}
                >
                  Percent
                </span>
                <Toggle
                  checked={predictPointsMode}
                  onChange={(checked) => setPredictPointsMode(!!checked)}
                  label={
                    predictPointsMode
                      ? "Entering predictions as points"
                      : "Entering predictions as percent"
                  }
                />
                <span
                  className={`muted gradeCalcInlineValue ${predictPointsMode ? "gradeCalcScopeLabelActive" : ""}`}
                >
                  Points
                </span>
              </div>
            </div>

            <label className="gradeCalcInlineControl gradeCalcInlineControlGroup">
              <span className="gradeCalcFieldLabel gradeCalcInlineHeading">
                <span className="muted">Default prediction (%)</span>
                <InfoTip
                  label="Default prediction help"
                  text="This is a quick-fill value used when you click Apply Default To Visible Ungraded. It does not automatically affect calculations by itself."
                />
              </span>
              <input
                className="gradeCalcInlineInput"
                type="number"
                min="0"
                max="100"
                value={defaultPrediction}
                onChange={(e) => setDefaultPrediction(e.target.value)}
              />
            </label>

            <label className="gradeCalcField gradeCalcFieldWide">
              <span className="muted gradeCalcFieldTitle">
                Search assignment
              </span>
              <input
                type="text"
                placeholder={
                  searchScope === "all"
                    ? "Search assignment or class name..."
                    : "Quiz, midterm, lab..."
                }
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </label>
          </div>

          <div className="rowWrap">
            <span className={gradeSensitiveBadgeClass("badgeSuccess")}>
              Projected with predictions:{" "}
              {displayGrade(fmtPct(displayedProjectedPercent))}
            </span>
            {groupWeightedProjection ? (
              <span
                className={gradeSensitiveBadgeClass("badgeSuccess")}
                title={
                  groupWeightedProjection.usedAnyOverride
                    ? "Group-weighted projection (uses your custom group weights)"
                    : "Group-weighted projection (uses Canvas group weights)"
                }
              >
                Group-weighted:{" "}
                {displayGrade(fmtPct(groupWeightedProjection.percent))}
              </span>
            ) : null}
            <span
              className={`badge ${
                !showGrades
                  ? "badgeNeutral"
                  : lastProjectionDelta == null
                    ? "badgeNeutral"
                    : lastProjectionDelta >= 0
                      ? "badgeSuccess"
                      : "badgeWarn"
              }`}
            >
              Last change:{" "}
              {displayGrade(
                lastProjectionDelta == null
                  ? "-"
                  : `${lastProjectionDelta >= 0 ? "+" : ""}${lastProjectionDelta.toFixed(2)} pts`,
              )}
            </span>
          </div>

          <div className="rowWrap">
            <button
              type="button"
              className="btn"
              onClick={applyDefaultPredictionToVisible}
              title="Apply the default % to all visible ungraded assignments"
            >
              Apply Default To All Ungraded
            </button>
            <button
              type="button"
              className="btn"
              onClick={applyDefaultToUnpredicted}
              title="Apply the default % only to visible ungraded assignments that don't already have a prediction"
            >
              Apply Default To Unpredicted
            </button>
            <button
              type="button"
              className="btn"
              onClick={applyActualScoresToVisible}
              title="Use each assignment's actual Canvas score as its prediction for visible scored items"
            >
              Apply Actual Scores
            </button>
            <button
              type="button"
              className="btn"
              onClick={clearVisiblePredictions}
            >
              Clear Visible Predictions
            </button>
          </div>

          <div className="muted gradeCalcBasis">
            Calculation basis: showing {filteredAssignments.length} matching
            assignments from{" "}
            {searchScope === "all"
              ? `${summaries.length} classes`
              : "the selected class"}
            ; {filteredOverrideCount} custom weight overrides and{" "}
            {scoreOverrideCount} score unlock overrides are active.
          </div>

          {weightMessage ? (
            <div className="authHint">{weightMessage}</div>
          ) : null}
          {overridesErrorDisplay ? (
            <ErrorBox error={overridesErrorDisplay} />
          ) : null}
          {allAssignmentsErrorDisplay && allAssignments.length > 0 ? (
            <ErrorBox error={allAssignmentsErrorDisplay} />
          ) : null}

          {filteredAssignments.length === 0 ? (
            <div className="muted">No assignments matched your search.</div>
          ) : (
            <ul className="gradeCalcList gradeCalcListScrollable">
              {filteredAssignments.map((assignment) => {
                const key = assignmentIdentity(assignment);
                const row =
                  stats.rows.find((item) => item.key === key) ||
                  buildStats(
                    [assignment],
                    predictedById,
                    weightOverridesById,
                    scoreOverridesById,
                  ).rows[0];
                const courseLabel =
                  searchScope === "all" ? formatCourseTitle(assignment?.course_name) : null;
                const predictValue = predictedById[key] ?? "";
                const draftPredictValue = getPredictionDraftValue(key);
                const effectivePoints = row?.effectivePoints;
                const basePoints = row?.basePoints;
                const saving = savingWeightKey === key;
                const hasScoreOverride = !!scoreOverridesById?.[key]?.enabled;
                const isEditingThis = editingKey === key;

                let statusText = "Not submitted or scored";
                if (row?.countedAsGraded) {
                  statusText = hasScoreOverride ? "Score unlocked" : "Submitted and scored";
                } else if (row?.pendingScore) {
                  statusText = "Scored but not submitted";
                } else if (assignment?.submitted === true) {
                  statusText = "Submitted but not scored yet";
                }

                return (
                  <li key={key} className="gradeCalcListItem">
                    <div className="gradeCalcListMain">
                      <div className="gradeCalcItemTitleRow">
                        <span className="gradeCalcItemTitle">{assignment.name}</span>
                        {row?.isWeightOverridden ? (
                          <span className="badge badgeNeutral">Custom weight</span>
                        ) : null}
                        {hasScoreOverride ? (
                          <span className="badge badgeWarn">Score modified</span>
                        ) : null}
                      </div>
                      {courseLabel ? (
                        <div className="muted">{courseLabel}</div>
                      ) : null}
                      <div className="muted">
                        Canvas weight:{" "}
                        {Number.isFinite(basePoints)
                          ? `${fmtPoints(basePoints)} pts`
                          : "Not set"}
                        {row?.isWeightOverridden && Number.isFinite(effectivePoints)
                          ? ` (Effective weight: ${fmtPoints(effectivePoints)} pts)`
                          : ""}
                      </div>
                      <div className="muted">{statusText}</div>
                    </div>

                    <div className="gradeCalcListControls">
                      <div className="gradeCalcListMeta">
                        {!row?.hasEffectivePoints ? (
                          <span className="badge badgeNeutral gradeCalcNoImpactBadge">
                            No grade impact (0 pts)
                          </span>
                        ) : row?.countedAsGraded ? (
                          <span
                            className={`${gradeSensitiveBadgeClass("badgeSuccess")} gradeCalcScorePill`}
                          >
                            {displayGrade(
                              fmtPct(
                                toPct(row?.score, row?.effectivePoints),
                              ),
                            )}
                          </span>
                        ) : editingPredictionKey === key ? (
                          (() => {
                            const pointsModeForRow =
                              predictPointsMode &&
                              Number.isFinite(effectivePoints) &&
                              effectivePoints > 0;
                            const defaultPct = clampPercent(defaultPrediction, 85);
                            const placeholderVal = pointsModeForRow
                              ? ((defaultPct / 100) * effectivePoints).toFixed(2)
                              : String(defaultPct);
                            const commit = (raw) => {
                              const trimmed = String(raw ?? "").trim();
                              if (!trimmed) {
                                commitPredictionDraft(key, "");
                                return;
                              }
                              if (pointsModeForRow) {
                                const n = Number(trimmed);
                                if (!Number.isFinite(n)) return;
                                const pct = (n / effectivePoints) * 100;
                                commitPredictionDraft(key, String(pct));
                              } else {
                                commitPredictionDraft(key, trimmed);
                              }
                            };
                            return (
                              <div className="gradeCalcPredictInputRow">
                                <input
                                  type="number"
                                  min="0"
                                  max={
                                    pointsModeForRow
                                      ? String(effectivePoints)
                                      : "100"
                                  }
                                  step="0.01"
                                  autoFocus
                                  value={draftPredictValue}
                                  placeholder={placeholderVal}
                                  onChange={(e) => {
                                    const next = e.target.value;
                                    setPredictionDraftById((prev) => ({
                                      ...(prev || {}),
                                      [key]: next,
                                    }));
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                      e.preventDefault();
                                      commit(e.currentTarget.value);
                                      setEditingPredictionKey(null);
                                    } else if (e.key === "Escape") {
                                      setEditingPredictionKey(null);
                                    }
                                  }}
                                />
                                <span className="muted gradeCalcPredictUnit">
                                  {pointsModeForRow ? "pts" : "%"}
                                </span>
                                <button
                                  type="button"
                                  className="btn gradeCalcApplyBtn"
                                  onClick={() => {
                                    commit(draftPredictValue);
                                    setEditingPredictionKey(null);
                                  }}
                                >
                                  Apply
                                </button>
                                <button
                                  type="button"
                                  className="btn"
                                  onClick={() => setEditingPredictionKey(null)}
                                >
                                  Cancel
                                </button>
                              </div>
                            );
                          })()
                        ) : (
                          <div className="gradeCalcPredictPillRow">
                            {predictValue ? (
                              <button
                                type="button"
                                className="gradeCalcPredictPill"
                                onClick={() => {
                                  const pointsModeForRow =
                                    predictPointsMode &&
                                    Number.isFinite(effectivePoints) &&
                                    effectivePoints > 0;
                                  const seed = pointsModeForRow
                                    ? (
                                        (Number(predictValue) / 100) *
                                        effectivePoints
                                      ).toFixed(2)
                                    : predictValue;
                                  setPredictionDraftById((prev) => ({
                                    ...(prev || {}),
                                    [key]: seed,
                                  }));
                                  setEditingPredictionKey(key);
                                }}
                                title="Click to edit prediction"
                              >
                                {(() => {
                                  const pct = Number(predictValue);
                                  if (
                                    predictPointsMode &&
                                    Number.isFinite(effectivePoints) &&
                                    effectivePoints > 0 &&
                                    Number.isFinite(pct)
                                  ) {
                                    const pts = (pct / 100) * effectivePoints;
                                    return displayGrade(
                                      `${fmtPoints(pts)} / ${fmtPoints(effectivePoints)} pts`,
                                    );
                                  }
                                  return displayGrade(fmtPct(pct));
                                })()}
                              </button>
                            ) : (
                              <button
                                type="button"
                                className="gradeCalcPredictPill gradeCalcPredictPillEmpty"
                                onClick={() => setEditingPredictionKey(key)}
                                title="Click to add a prediction"
                              >
                                Predict score
                              </button>
                            )}
                            {row?.pendingScore ? (
                              <button
                                type="button"
                                className="btn gradeCalcUseScoreBtn"
                                onClick={() => {
                                  const pct = toPct(row.score, row.effectivePoints);
                                  if (pct != null) {
                                    commitPredictionDraft(key, String(pct));
                                  }
                                }}
                                title="Apply the existing Canvas score as a prediction"
                              >
                                Use actual score ({displayGrade(fmtPct(toPct(row.score, row.effectivePoints)))})
                              </button>
                            ) : null}
                          </div>
                        )}

                        {saving ? (
                          <span className="badge badgeNeutral gradeCalcSavingBadge">
                            Saving weight...
                          </span>
                        ) : null}
                      </div>

                      <div className="gradeCalcRowEffort">
                        <WorkloadEstimateControl
                          courseId={assignment.course_id}
                          assignmentId={assignment.id}
                          compactLabels={true}
                        />
                      </div>

                      <div className="gradeCalcRowActions">
                        {assignment?.html_url ? (
                          <a
                            className="btn"
                            href={assignment.html_url}
                            target="_blank"
                            rel="noreferrer"
                            title="Open assignment in Canvas"
                          >
                            View
                          </a>
                        ) : null}
                        <button
                          type="button"
                          ref={(node) => {
                            if (node) editAnchorRefs.current[key] = node;
                            else delete editAnchorRefs.current[key];
                          }}
                          className="effortGearBtn gradeCalcEditBtn"
                          onClick={() =>
                            isEditingThis
                              ? closeEditPopup()
                              : openEditPopup(assignment)
                          }
                          title="Edit assignment assumptions"
                          aria-label="Edit assignment assumptions"
                          aria-expanded={isEditingThis}
                        >
                          <svg
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            aria-hidden="true"
                          >
                            <path
                              d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Zm9 3.5-.95-.55a7.9 7.9 0 0 0-.17-1.03l.78-.8a1 1 0 0 0 .16-1.2l-1.1-1.9a1 1 0 0 0-1.14-.46l-1.03.32a8.23 8.23 0 0 0-.89-.52l-.16-1.07a1 1 0 0 0-.99-.84h-2.2a1 1 0 0 0-.99.84l-.16 1.07c-.31.14-.61.31-.89.52l-1.03-.32a1 1 0 0 0-1.14.46l-1.1 1.9a1 1 0 0 0 .16 1.2l.78.8c-.08.34-.13.68-.17 1.03L3 12a1 1 0 0 0-.5.86v2.28a1 1 0 0 0 .5.86l.95.55c.04.35.1.69.17 1.03l-.78.8a1 1 0 0 0-.16 1.2l1.1 1.9a1 1 0 0 0 1.14.46l1.03-.32c.28.2.58.37.89.52l.16 1.07a1 1 0 0 0 .99.84h2.2a1 1 0 0 0 .99-.84l.16-1.07c.31-.14.61-.31.89-.52l1.03.32a1 1 0 0 0 1.14-.46l1.1-1.9a1 1 0 0 0-.16-1.2l-.78-.8c.08-.34.13-.68.17-1.03l.95-.55a1 1 0 0 0 .5-.86v-2.28A1 1 0 0 0 21 12Z"
                              stroke="currentColor"
                              strokeWidth="1.3"
                            />
                          </svg>
                          Edit
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <div className="card gradeCalcCard">
        <div className="cardBody stack">
          <div className="gradeCalcSectionHeading">
            <div className="h3">Minimum Needed On Assignment</div>
            <InfoTip
              label="Minimum needed help"
              text="This calculator includes submitted-and-scored work, the selected assignment, and any other assignments in the selected class that you explicitly predicted."
            />
          </div>

          <div className="gradeCalcControls">
            <label className="gradeCalcField gradeCalcFieldWide">
              <span className="muted">Assignment / Midterm / Final</span>
              <select
                className="select"
                value={selectedNeedAssignmentId}
                onChange={(e) => setSelectedNeedAssignmentId(e.target.value)}
                disabled={minNeededCandidates.length === 0}
              >
                {minNeededCandidates.map((row) => (
                  <option
                    key={row.assignment.id}
                    value={String(row.assignment.id)}
                  >
                    {row.assignment.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="gradeCalcInlineControl">
            <input
              type="checkbox"
              checked={useOtherPredictionsInMinNeeded}
              onChange={(e) =>
                setUseOtherPredictionsInMinNeeded(e.target.checked)
              }
            />
            <span className="muted">
              Include other predicted assignments in this calculation
            </span>
          </label>

          {needCalculator ? (
            <>
              <div className="rowWrap">
                <span className="badge badgeNeutral">
                  Target overall:{" "}
                  {useLetterTarget
                    ? `${targetLetter} (${needCalculator.targetPercent.toFixed(0)}%)`
                    : fmtPct(needCalculator.targetPercent)}
                </span>
                <span className={gradeSensitiveBadgeClass("badgeWarn")}>
                  Needed on selected item:{" "}
                  {displayGrade(fmtPct(needCalculator.requiredPctOnSelected))}
                </span>
                <span className="badge badgeNeutral">
                  Needed points:{" "}
                  {displayGrade(
                    `${Number.isFinite(needCalculator.requiredOnSelected) ? needCalculator.requiredOnSelected.toFixed(2) : "-"} / ${needCalculator.selected.effectivePoints.toFixed(2)}`,
                  )}
                </span>
                <span className="badge badgeNeutral">
                  Modeled total points:{" "}
                  {fmtPoints(needCalculator.totalPossible)}
                </span>
                {needCalculator.requiredPctOnSelected > 100 ? (
                  <span className={gradeSensitiveBadgeClass("badgeDanger")}>
                    Above 100% needed with current assumptions
                  </span>
                ) : null}
              </div>
              <div className="muted gradeCalcBasis">
                Calculation basis: {stats.gradedCount} graded items, selected
                item weight {fmtPoints(needCalculator.selected.effectivePoints)}{" "}
                pts, {needCalculator.otherPredictedCount} other predicted items
                in the selected class{" "}
                {useOtherPredictionsInMinNeeded
                  ? "(included)"
                  : "(excluded from this calc)"}
                , and{" "}
                {Math.max(
                  0,
                  stats.excludedCount - needCalculator.otherPredictedCount - 1,
                )}{" "}
                remaining excluded items without predictions.
              </div>
            </>
          ) : (
            <div className="muted">
              No point-based ungraded assignments are available in the selected
              class right now.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
