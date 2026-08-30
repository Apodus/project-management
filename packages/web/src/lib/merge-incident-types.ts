import type { components } from "./api-types";

// @pm/web MIRRORS @pm/shared, it does not import it (there is no dependency,
// by design). Keying this Record off the GENERATED wire union is the mirror
// seal: if a new incident type reaches the API and this file does not follow,
// `pnpm typecheck` fails here rather than the UI quietly labelling a
// dangling gitlink as an orphaned inner.
export type MergeIncidentType = components["schemas"]["MergeIncident"]["type"];

export interface MergeIncidentTypeDisplay {
  /** Title-cased, matching the formatStatus() output it replaces and the
   *  state badge rendered beside it. Deliberately NOT @pm/shared's sentence-
   *  case `label`. */
  label: string;
  /** What the incident's SHA is, in one or two words, for THIS direction. */
  shaLabel: string;
}

export const INCIDENT_TYPE_INFO: Record<MergeIncidentType, MergeIncidentTypeDisplay> = {
  orphaned_inner: { label: "Orphaned Inner", shaLabel: "orphaned" },
  dangling_gitlink: { label: "Dangling Gitlink", shaLabel: "gitlink target" },
};

/**
 * Total lookup. Timeline events type `type` as an optional plain string on the
 * wire, so an unrecognized value is representable — and a renderer must then
 * say nothing directional about it.
 */
export function incidentTypeDisplay(
  type: string | undefined,
): MergeIncidentTypeDisplay | undefined {
  if (type === undefined) return undefined;
  return Object.prototype.hasOwnProperty.call(INCIDENT_TYPE_INFO, type)
    ? (INCIDENT_TYPE_INFO as Record<string, MergeIncidentTypeDisplay>)[type]
    : undefined;
}
