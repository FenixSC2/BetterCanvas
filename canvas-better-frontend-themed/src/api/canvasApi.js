// src/api/canvasApi.js
import { loadingBus } from "../lib/loadingBus";
const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000";

async function request(path, { signal } = {}) {
  loadingBus.start(); 
  try {
    const res = await fetch(`${API_BASE}${path}`, { signal });

    if (!res.ok) {
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
};
