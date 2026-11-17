/**
 * Client-side filtering for list views (journal feed, tag view, …).
 *
 * Filters never hit the server: they narrow whatever entries the view has
 * already loaded, so matches appear as more pages arrive.
 */

/** Split a filter query into lowercase terms; every term must match. */
export function filterTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/u).filter(Boolean);
}

/** True when every term appears in `text` (case-insensitive). */
export function matchesFilter(text: string, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const haystack = text.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}
