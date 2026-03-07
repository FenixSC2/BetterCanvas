// src/api/canvasApi.js
import { loadingBus } from "../lib/loadingBus";
const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000";

async function request(path, { signal, method = "GET" } = {}) {
  loadingBus.start();
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      signal,
      method,
      credentials: "include",
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

      // Handle 403 Forbidden - Canvas token required (user is authenticated but needs to add token)
      if (res.status === 403) {
        const err = new Error("Canvas token required. Please add your Canvas API token.");
        err.status = 403;
        err.needsToken = true;
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
  getUndatedAssignments: (opts) => request("/api/undated-assignments", opts),
  getDashboard: (upcomingLimit = 20, opts) =>
    request(`/api/dashboard?upcoming_limit=${upcomingLimit}`, opts),

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

    getCandidatesForHiding: (opts) => request("/api/candidates-for-hiding", opts),
};
