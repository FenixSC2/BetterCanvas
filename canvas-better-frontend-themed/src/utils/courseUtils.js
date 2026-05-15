export function formatCourseTitle(courseName) {
  if (!courseName) return courseName;

  // Pattern: COURSE_CODE CRN TITLE SEC SECTION [Summer 2026 [BOS...]]
  const withSec = courseName.match(
    /^([A-Z]+\d+)\s+\d+\s+(.*?)\s+SEC(?:TION)?\s*([A-Z0-9-]+)/i
  );
  if (withSec) {
    return `${withSec[1]} ${withSec[2].trim()} -- SEC ${withSec[3].toUpperCase()}`;
  }

  // No section — strip CRN and trailing semester/location noise
  const noSec = courseName.match(
    /^([A-Z]+\d+)\s+\d+\s+(.*?)(?:\s+(?:Spring|Summer|Fall|Winter)\s|\s+\[|$)/i
  );
  if (noSec) return `${noSec[1]} ${noSec[2].trim()}`;

  // Fallback: strip at SEC
  const secIdx = courseName.lastIndexOf("SEC");
  return secIdx !== -1 ? courseName.slice(0, secIdx).trim() : courseName;
}
