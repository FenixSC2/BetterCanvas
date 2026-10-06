// src/api/canvasApi.js
import { loadingBus } from "../lib/loadingBus";
export const API_BASE =
  import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? "http://localhost:8000" : "https://api.canvassist.com");

async function request(path, { signal, method = "GET", body } = {}) {
  loadingBus.start();
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      signal,
      method,
      credentials: "include",
      headers:
        body !== undefined
          ? {
              "Content-Type": "application/json",
            }
          : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      // Handle 401 Unauthorized - user session expired or token revoked
      if (res.status === 401) {
        // Clear auth state and redirect to login
        window.dispatchEvent(new CustomEvent("auth:unauthorized"));
        const err = new Error("Session expired. Please log in again.");
        err.status = 401;
        throw err;
      }

      // Handle 403 Forbidden - Canvas token required (user is authenticated but needs to add token,
      // or their existing token has been revoked/expired by Canvas).
      if (res.status === 403) {
        const detail = await res
          .json()
          .then((d) => (typeof d?.detail === "string" ? d.detail : ""))
          .catch(() => "");
        const expired = /invalid or expired/i.test(detail);
        if (expired) {
          window.dispatchEvent(
            new CustomEvent("canvas:tokenInvalid", { detail: { reason: "expired" } })
          );
        }
        const err = new Error(
          detail || (expired
            ? "Canvas token invalid or expired. Please re-submit your Canvas API token."
            : "Canvas token required. Please add your Canvas API token.")
        );
        err.status = 403;
        err.needsToken = true;
        err.tokenExpired = expired;
        throw err;
      }

      const text = await res.text().catch(() => "");
      const err = new Error(text || `${res.status} ${res.statusText}`);
      err.status = res.status;
      throw err;
    }

    return res.json();
  } finally {
    loadingBus.end();
  }
}

export const canvasApi = {
  getProfile: (opts) => request("/api/profile", opts),
  getCourses: (opts) => request("/api/courses", opts),
  getCourseAssignments: (courseId, limit = 3, opts) =>
    request(`/api/courses/${courseId}/assignments?limit=${limit}`, opts),
  getCourseAssignmentsIncludingHidden: (courseId, limit = 3, opts) =>
    request(`/api/courses/${courseId}/assignments?limit=${limit}&include_hidden=true`, opts),
  getUpcoming: (arg1, arg2) => {
    let limit = 25;
    let opts = {};

    // Support both:
    // getUpcoming(limit, opts)
    // getUpcoming(opts)
    if (typeof arg1 === "number" || arg1 == null) {
      limit = arg1 ?? 25;
      opts = arg2 || {};
    } else if (typeof arg1 === "object") {
      opts = arg1 || {};
      limit = 25;
    }

    return request(`/api/upcoming?limit=${encodeURIComponent(limit)}`, opts);
  },
  getUpcomingCrossCheck: (arg1, arg2) => {
    let limit = 200;
    let opts = {};

    // Support both:
    // getUpcomingCrossCheck(limit, opts)
    // getUpcomingCrossCheck(opts)
    if (typeof arg1 === "number" || arg1 == null) {
      limit = arg1 ?? 200;
      opts = arg2 || {};
    } else if (typeof arg1 === "object") {
      opts = arg1 || {};
      limit = 200;
    }

    return request(
      `/api/upcoming-cross-check?limit=${encodeURIComponent(limit)}`,
      opts
    );
  },
  getUndatedAssignments: (opts) => request("/api/undated-assignments", opts),
  getPersonalAssignmentDates: (opts) => request("/api/personal-assignment-dates", opts),
  upsertPersonalAssignmentDate: (courseId, assignmentId, due_at, opts) =>
    request(`/api/personal-assignment-dates/${courseId}/${assignmentId}`, {
      ...opts,
      method: "PUT",
      body: { due_at },
    }),
  deletePersonalAssignmentDate: (courseId, assignmentId, opts) =>
    request(`/api/personal-assignment-dates/${courseId}/${assignmentId}`, {
      ...opts,
      method: "DELETE",
    }),
  getDashboard: (upcomingLimit = 20, opts) =>
    request(`/api/dashboard?upcoming_limit=${upcomingLimit}`, opts),

  getAttendanceTabs: (opts) => request("/api/courses/attendance-tabs", opts),

  // Aggregated view for MyCourses
  getCourseSummaries: (nextLimit = 3, missingLimit = 10, opts) =>
    request(
      `/api/courses/summary?next_limit=${nextLimit}&missing_limit=${missingLimit}`,
      opts
    ),

    // New overview endpoint
    getOverview: (opts) => request("/api/overview", opts),

    // annoucnments endpoint
    getAnnouncements: (daysBack = 14, limit = 20, cache = "auto", opts) =>
      request(
        `/api/announcements?days_back=${encodeURIComponent(daysBack)}&limit=${encodeURIComponent(
          limit
        )}&cache=${encodeURIComponent(cache)}`,
        opts
      ),

    getAnnouncementLastSeen: (opts) => request("/api/announcements/last-seen", opts),

    setAnnouncementLastSeen: (announcementId, opts) =>
      request("/api/announcements/last-seen", {
        ...opts,
        method: "POST",
        body: { announcement_id: announcementId },
      }),

    // Hidden assignments management
    getHiddenAssignments: (opts) => request("/api/hidden-assignments", opts),

    addHiddenAssignment: (courseId, assignmentId, opts) =>
      request(
        `/api/hidden-assignments?course_id=${courseId}&assignment_id=${assignmentId}`,
        { ...opts, method: "POST" }
      ),

    removeHiddenAssignment: (courseId, assignmentId, opts) =>
      request(
        `/api/hidden-assignments/${courseId}/${assignmentId}`,
        { ...opts, method: "DELETE" }
      ),

    getAssignmentWeightOverrides: (opts) =>
      request("/api/assignment-weight-overrides", opts),

    upsertAssignmentWeightOverride: (courseId, assignmentId, weight_points, opts) =>
      request(`/api/assignment-weight-overrides/${courseId}/${assignmentId}`, {
        ...opts,
        method: "PUT",
        body: { weight_points },
      }),

    deleteAssignmentWeightOverride: (courseId, assignmentId, opts) =>
      request(`/api/assignment-weight-overrides/${courseId}/${assignmentId}`, {
        ...opts,
        method: "DELETE",
      }),

    getCourseAssignmentGroups: (courseId, opts) =>
      request(`/api/courses/${courseId}/assignment-groups`, opts),

    getCourseDiscussions: (courseId, limit = 30, opts) =>
      request(
        `/api/courses/${courseId}/discussions?limit=${encodeURIComponent(limit)}`,
        opts,
      ),

    getDiscussionReplies: (courseId, topicId, opts) =>
      request(
        `/api/courses/${courseId}/discussions/${encodeURIComponent(topicId)}/replies`,
        opts,
      ),

    getAssignmentGroupWeightOverrides: (opts) =>
      request("/api/assignment-group-weight-overrides", opts),

    upsertAssignmentGroupWeightOverride: (courseId, groupId, weight_pct, opts) =>
      request(`/api/assignment-group-weight-overrides/${courseId}/${groupId}`, {
        ...opts,
        method: "PUT",
        body: { weight_pct },
      }),

    deleteAssignmentGroupWeightOverride: (courseId, groupId, opts) =>
      request(`/api/assignment-group-weight-overrides/${courseId}/${groupId}`, {
        ...opts,
        method: "DELETE",
      }),

    getGradeScalePreferences: (opts) =>
      request("/api/grade-scale-preferences", opts),

    upsertGradeScalePreference: (courseId, payload, opts) =>
      request(`/api/grade-scale-preferences/${courseId}`, {
        ...opts,
        method: "PUT",
        body: payload,
      }),

    getCandidatesForHiding: (opts) => request("/api/candidates-for-hiding", opts),

    getTodos: (opts) => request("/api/todos", opts),

    createTodo: (todo, opts) =>
      request("/api/todos", { ...opts, method: "POST", body: todo }),

    updateTodo: (todoId, todo, opts) =>
      request(`/api/todos/${encodeURIComponent(todoId)}`, {
        ...opts,
        method: "PUT",
        body: todo,
      }),

    deleteTodo: (todoId, deleteScope = "this-occurrence", opts) =>
      request(
        `/api/todos/${encodeURIComponent(todoId)}?delete_scope=${encodeURIComponent(deleteScope)}`,
        {
          ...opts,
          method: "DELETE",
        },
      ),
      getCompletedAssignments: (opts) =>
        request("/api/completed-assignments", opts),

      upsertCompletedAssignment: (
        courseId,
        assignmentId,
        status_source = "manual_completed",
        opts,
      ) =>
        request(`/api/completed-assignments/${courseId}/${assignmentId}`, {
          ...opts,
          method: "PUT",
          body: { status_source },
        }),

      deleteCompletedAssignment: (courseId, assignmentId, opts) =>
        request(`/api/completed-assignments/${courseId}/${assignmentId}`, {
          ...opts,
          method: "DELETE",
        }),
};
