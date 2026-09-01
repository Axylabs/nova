/**
 * Cluster routing kinds — the semantic addressing modes carried in the
 * cluster envelope. Numeric ids ride the wire; the strings are internal.
 *
 * Pure constants module (part of the `src/events/cluster` composition).
 */

/** Every envelope kind, in wire order (index = kind id). */
export const CLUSTER_KINDS = ["broadcast", "topic", "group", "user", "client", "presence"] as const;
export type ClusterKind = (typeof CLUSTER_KINDS)[number];

/** Wire encoding of a {@link ClusterKind} (single byte). */
export const CLUSTER_KIND_ID: Record<ClusterKind, number> = {
  broadcast: 0,
  topic: 1,
  group: 2,
  user: 3,
  client: 4,
  presence: 5,
};

/**
 * Envelope format version. A peer on a different version fails the version
 * check and its frames are counted as errors — mixed-version clusters during
 * a rolling upgrade degrade visibly instead of delivering corrupt frames.
 */
export const CLUSTER_ENV_VERSION = 2;

/** Map a numeric wire kind back to its name (`undefined` when out of range). */
export function clusterKindFromId(id: number): ClusterKind | undefined {
  return CLUSTER_KINDS[id];
}
