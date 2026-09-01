/**
 * Client record types — the server-side representation of a connected peer.
 *
 * Type-only module (part of the `src/events/types` barrel). The runtime lives
 * in `src/events/clients.ts` / `src/events/data.ts`.
 */
import type { ServerWebSocket } from "bun";
import type { WsData } from "../../core/state";

/** Per-connection state store attached to an active client record. */
export interface ClientData {
  /** Read a value previously `set` on this connection. */
  get(key: string): unknown;
  /** Store a value on this connection (arbitrary app state, per socket). */
  set(key: string, value: unknown): void;
  has(key: string): boolean;
  delete(key: string): boolean;
  clear(): void;
  keys(): string[];
  entries(): Array<[string, unknown]>;
  toJSON(): Record<string, unknown>;
}

/**
 * An active user connection — the server-side representation of "who is
 * connected, on whose behalf, and what to remember about them".
 *
 * - `id` is the connection id (the socket identity, unique per connection).
 * - `userId` is the identity this connection acts ON BEHALF OF (set via the
 *   `authenticate` hook, `hub.setUserId`, or later); several connections may
 *   share a `userId` (multi-tab / multi-device), and `hub.clientsByUser`
 *   groups them.
 * - `data` is the per-connection app store, cleared automatically on close.
 * - `groups` / `topics` are shared with the transport (`ws.data`), so control
 *   frames (`joinGroup` / `subscribe`) stay consistent with the events layer.
 */
export interface EventClient {
  /** stable connection id (ws identity, unique per socket) */
  readonly id: string;
  /** identity this connection acts on behalf of (undefined = anonymous) */
  readonly userId: string | undefined;
  /** arbitrary app metadata from `authenticate` (undefined if none) */
  readonly meta: Record<string, unknown> | undefined;
  /** per-connection app state store (auto-cleared on disconnect) */
  readonly data: ClientData;
  /** server-side client groups this connection belongs to */
  readonly groups: ReadonlySet<string>;
  /** topics/rooms this connection has joined */
  readonly topics: ReadonlySet<string>;
  /** epoch ms the socket connected */
  readonly connectedAt: number;
  /** remote IP (from the socket) */
  readonly ip: string;
  /** true after the socket closed (record is then detached) */
  readonly closed: boolean;
  /** the underlying socket (advanced / low-level use) */
  readonly ws: ServerWebSocket<WsData>;
}

/** A connection known to exist on ANOTHER instance (via cluster presence). */
export interface RemoteClient {
  clientId: string;
  /** the instance that reported this connection */
  instanceId: string;
  userId?: string;
  /** epoch ms the connection was (re)confirmed by its instance */
  lastSeen: number;
}
