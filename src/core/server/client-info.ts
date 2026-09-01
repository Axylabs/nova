/**
 * Client introspection view — the snapshot shape returned by
 * `server.getClient` / `server.getClients` and the GET /clients endpoint.
 *
 * `toClientInfo` is a PURE mapper from live socket state to the plain object.
 */
import type { ServerWebSocket } from "bun";
import type { WsData } from "../state";

/** A snapshot of an active client (from `getClient` / `getClients` / GET /clients). */
export interface ClientInfo {
  id: string;
  /** identity this connection acts on behalf of (undefined if none) */
  userId?: string;
  /** arbitrary app metadata from `authenticate` (undefined if none) */
  meta?: Record<string, unknown>;
  /** server-side groups this client belongs to */
  groups: string[];
  /** topics/rooms this client has joined */
  topics: string[];
  /** epoch ms the socket connected */
  connectedAt: number;
  /** remote IP (from the socket) */
  ip: string;
}

export function toClientInfo(ws: ServerWebSocket<WsData>): ClientInfo {
  return {
    id: ws.data.id,
    ...(ws.data.userId !== undefined ? { userId: ws.data.userId } : {}),
    ...(ws.data.meta !== undefined ? { meta: ws.data.meta } : {}),
    groups: [...ws.data.groups],
    topics: [...ws.data.topics],
    connectedAt: ws.data.connectedAt,
    ip: ws.remoteAddress,
  };
}
