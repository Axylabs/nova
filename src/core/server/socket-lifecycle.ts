/**
 * Socket lifecycle — the server-side `open` / `close` WebSocket handlers as
 * small `(state, ws)` actions (functional-composition style, like the other
 * core action modules). The composition root (`index.ts`) wires them into
 * `Bun.serve`'s websocket handlers.
 */
import type { ServerWebSocket } from "bun";
import type { Bindings } from "../../bindings/types";
import { joinGroup as addToGroup, leaveGroup as removeFromGroup } from "../groups";
import { sendControl } from "../outbound";
import { adoptGrave, burySession } from "../resume";
import { leaveRoom } from "../rooms";
import type { ServerState, WsData } from "../state";

/** A socket opened: register, adopt resume history, seed groups, greet. */
export function onSocketOpen(state: ServerState, ws: ServerWebSocket<WsData>): void {
  state.sockets.add(ws);
  // belt-and-suspenders: an auth race could double-register an id — kick the stale session
  const existing = state.clients.get(ws.data.id);
  if (existing && existing !== ws) existing.close(1000, "replaced by newer session");
  state.clients.set(ws.data.id, ws);
  // resume: adopt a parked history for this client id (continues the
  // previous session's delivery-seq stream) BEFORE anything is sent
  adoptGrave(state, ws);
  // events-layer attach (client record + presence) BEFORE group seeding
  state.onConnect?.(ws);
  for (const g of ws.data.groups) addToGroup(state, ws, g);
  greetClient(state, ws);
}

/** Announce wire version + capabilities, then pin this client's identity. */
function greetClient(state: ServerState, ws: ServerWebSocket<WsData>): void {
  // announce our wire version + capabilities so clients can negotiate
  sendControl(state, ws, "hello", {
    version: (state.bindings as Bindings).wireVersion,
    caps: [],
    lastSeq: 0,
  });
  // then assign identity so the client knows its id + server-side groups
  sendControl(state, ws, "welcome", { clientId: ws.data.id, groups: [...ws.data.groups] });
}

/** A socket closed: detach everywhere and park the resume history. */
export function onSocketClose(state: ServerState, ws: ServerWebSocket<WsData>): void {
  // events-layer detach FIRST (client record still carries groups/topics)
  state.onDisconnect?.(ws);
  state.sockets.delete(ws);
  state.clients.delete(ws.data.id);
  for (const g of ws.data.groups) removeFromGroup(state, ws, g);
  ws.data.groups.clear();
  for (const t of ws.data.topics) leaveRoom(state, ws, t);
  ws.data.topics.clear();
  delete ws.data.queue;
  // resume: park the sent-history so a reconnect with the same id can
  // pick up where this session left off (no-op when resume is off)
  burySession(state, ws);
}
