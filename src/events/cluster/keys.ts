/**
 * Shared-state key builders — the canonical key names used in the
 * `ClusterStateStore` (Redis in production). Centralized so every instance
 * agrees on the layout; pure string functions.
 */

/** User-group membership set (`member` = userId). */
export const userGroupStateKey = (name: string): string => `ignex:group-users:${name}`;

/** Client-group membership set (`member` = clientId). */
export const clientGroupStateKey = (name: string): string => `ignex:group:${name}`;

/** Per-user presence index (`member` = `{instanceId}:{clientId}`). */
export const presenceUserKey = (userId: string): string => `ignex:presence:user:${userId}`;

/** Per-instance presence index (`member` = clientId). */
export const presenceInstanceKey = (instanceId: string): string =>
  `ignex:presence:instance:${instanceId}`;

/** Client data blob (JSON string). */
export const clientDataKey = (clientId: string): string => `ignex:client-data:${clientId}`;

/**
 * Split a `{instanceId}:{clientId}` presence member back into its parts.
 * Returns `null` for malformed members (never crashes on foreign data).
 */
export function parsePresenceMember(
  member: string,
): { instanceId: string; clientId: string } | null {
  const idx = member.indexOf(":");
  if (idx <= 0) return null;
  return { instanceId: member.slice(0, idx), clientId: member.slice(idx + 1) };
}
