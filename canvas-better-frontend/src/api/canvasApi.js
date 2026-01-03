const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000";

async function request(path, { signal } = {}) {
  const res = await fetch(`${API_BASE}${path}`, { signal });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const message = text || `${res.status} ${res.statusText}`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export const canvasApi = {
  getProfile: (opts) => request("/api/profile", opts),
  getCourses: (opts) => request("/api/courses", opts),
  getCourseAssignments: (courseId, limit = 3, opts) =>
    request(`/api/courses/${courseId}/assignments?limit=${limit}`, opts),
  getUpcoming: (limit = 25, opts) => request(`/api/upcoming?limit=${limit}`, opts),
  getDashboard: (upcomingLimit = 20, opts) =>
    request(`/api/dashboard?upcoming_limit=${upcomingLimit}`, opts),
};
