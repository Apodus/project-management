// Typed accessor for the project-level `settings.epic_categories` sub-block.
//
// The project `settings` blob is typed as `unknown` on the Project response
// (the server stores it as opaque JSON), so reads must narrow it manually.
// `epic_categories` is an array of `{ name, color, sort_order }`; we always
// return a defensively-copied, sort_order-ordered list.

export interface EpicCategory {
  name: string;
  color: string;
  sort_order: number;
}

/**
 * Read the epic categories off a project's opaque settings blob, sorted by
 * `sort_order`. Returns `[]` when the project (or the sub-block) is absent.
 */
export function epicCategoriesFromProject(
  project: { settings?: unknown } | undefined,
): EpicCategory[] {
  return (
    (project?.settings as { epic_categories?: EpicCategory[] } | null | undefined)
      ?.epic_categories ?? []
  )
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order);
}
