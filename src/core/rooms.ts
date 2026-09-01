/**
 * Room (topic) membership + fan-out. Pure set operations over `state.rooms`,
 * wired to replay (`joinRoom` sends recorded history) and the outbound path
 * (`publishToRoom` fans a frame out to every member).
 */
import type { ServerWebSocket } from "bun";
import { sendFrame } from "./outbound";
import { recordReplay, replayFrames } from "./replay";
import type { ServerState, WsData } from "./state";

/** Join `ws` to `topic`, replaying any recorded history (oldest → newest). */
export function joinRoom(state: ServerState, ws: ServerWebSocket<WsData>, topic: string): void {
  // every join path (control frames, programmatic, auth-seeded) is gated
  if (state.authorizeTopic !== undefined && !state.authorizeTopic(topic, ws)) {
    state.metrics.rejectedJoins++;
    return;
  }
  ws.data.topics.add(topic);
  let set = state.rooms.get(topic);
  if (!set) {
    set = new Set();
    state.rooms.set(topic, set);
  }
  set.add(ws);
  // snapshot replay goes through the normal outbound path so (with resume
  // enabled) the frames are stamped into this connection's seq stream and
  // recorded in its history — clients can gap-recover across them too.
  for (const frame of replayFrames(state, topic)) sendFrame(state, ws, frame);
}

/** Leave `topic`; prune the room when it becomes empty. */
export function leaveRoom(state: ServerState, ws: ServerWebSocket<WsData>, topic: string): void {
  ws.data.topics.delete(topic);
  const set = state.rooms.get(topic);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) state.rooms.delete(topic);
}

/** Live topic names (with at least one subscriber). */
export function roomTopics(state: ServerState): string[] {
  return [...state.rooms.keys()];
}

/** Record replay (if enabled) then deliver `frame` to every room member. */
export function publishToRoom(state: ServerState, topic: string, frame: Uint8Array): void {
  recordReplay(state, topic, frame);
  const set = state.rooms.get(topic);
  if (!set) return;
  for (const ws of set) sendFrame(state, ws, frame);
}
