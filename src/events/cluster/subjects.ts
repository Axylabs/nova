/**
 * Cluster subject space — the broker channel names derived from the prefix.
 *
 * Every instance subscribes ONE wildcard channel (full-mesh kinds + presence)
 * plus its own per-instance channel (routed targeted delivery). The envelope
 * carries routing, so these names are pure syntax.
 *
 * Pure factory — no I/O.
 */
import type { EmitTargetKind } from "../types";

/** The three subject shapes used by cluster messaging. */
export interface ClusterSubjects {
  /** the one channel every instance subscribes to (full-mesh kinds) */
  all(): string;
  /** per-instance channel — routed targeted delivery lands here only */
  instance(id: string): string;
  /** publish channel for a target kind (also the external visibility of the subject space) */
  event(kind: EmitTargetKind, key: string | undefined, name: string): string;
}

export function createClusterSubjects(prefix: string): ClusterSubjects {
  const base = `${prefix}.cluster`;
  return {
    all: () => `${base}.>`,
    instance: (id) => `${base}.instance.${id}`,
    event: (kind, key, name) =>
      key === undefined ? `${base}.${kind}.${name}` : `${base}.${kind}.${key}.${name}`,
  };
}
