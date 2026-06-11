import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { search, type SearchOptions, type SearchResult } from "@/lib/api";

// ─── Server FTS search hook (Campaign C4) ─────────────────────────
// Thin TanStack Query wrapper over the api.ts `search()` (GET /search, FTS5).
// Enabled only for a non-empty trimmed query; keeps the previous hits rendered
// while a new keystroke's query is in flight (placeholderData) so result lists
// never flash empty mid-typing.

export const ftsSearchKeys = {
  all: ["fts-search"] as const,
  query: (q: string, opts?: SearchOptions) =>
    [...ftsSearchKeys.all, { q, ...opts }] as const,
};

export function useFtsSearch(q: string, opts?: SearchOptions) {
  const trimmed = q.trim();
  return useQuery<SearchResult[]>({
    queryKey: ftsSearchKeys.query(trimmed, opts),
    queryFn: () => search(trimmed, opts),
    enabled: trimmed.length > 0,
    placeholderData: keepPreviousData,
  });
}
