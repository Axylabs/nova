/**
 * Inbound routing — table-driven dispatch for app + control frames received
 * from a socket. Parses the envelope, enforces `maxMessageSize` + the inbound
 * allowlist, and routes to handlers / room operations.
 *
 * Decode is HEADER-FIRST: only the cheap envelope (version + event id) is
 * parsed before deciding what to do, so an event that isn't in the inbound
 * allowlist (or is a control frame) never pays the cost of a full `.unpack()`
 * payload decode — a client can't force us to fully materialize a frame we're
 * going to discard.
 */
import type { ServerWebSocket } from "bun";
import { decodePayload, isControlId, readFrameHeader, WIRE_VERSION } from "../generated/registry";
import type { ControlEventName, ControlEvents, EventName } from "../schema";
import { sendControl } from "./outbound";
import { joinRoom, leaveRoom } from "./rooms";
import { joinGroup, leaveGroup } from "./groups";
import type { ServerState, WsData } from "./state";

// allocated once per process, reused for every inbound text frame
const textEncoder = new TextEncoder();

export function handleMessage(
  state: ServerState,
  ws: ServerWebSocket<WsData>,
  raw: string | Buffer,
): void {
  const bytes = typeof raw === "string" ? textEncoder.encode(raw) : new Uint8Array(raw as Buffer);
  if (state.maxMessageSize !== undefined && bytes.byteLength > state.maxMessageSize) {
    state.metrics.protocolErrors++;
    ws.close(1009, "message too big");
    return;
  }
  const header = readFrameHeader(bytes);
  if (!header) {
    state.metrics.protocolErrors++;
    return; // undecodable / wrong version / unknown id — drop
  }
  if (isControlId(header.id)) {
    state.metrics.inboundControl++;
    handleControl(state, ws, header.name as ControlEventName, decodePayload(header.id, bytes) as never);
    return;
  }
  const name = header.name as EventName;
  if (!state.inbound.has(name)) return; // not an allowed inbound event — no payload decode
  state.metrics.inbound++;
  state.inboundHandlers.get(name)?.(decodePayload(header.id, bytes), ws);
}

export function handleControl(
  state: ServerState,
  ws: ServerWebSocket<WsData>,
  name: ControlEventName,
  payload: unknown,
): void {
  switch (name) {
    case "hello": {
      const p = payload as ControlEvents["hello"];
      ws.data.version = p.version;
      ws.data.lastSeq = p.lastSeq;
      if (p.version !== WIRE_VERSION) {
        // protocol version mismatch — refuse this client
        ws.close(1002, "wire version mismatch");
      }
      break;
    }
    case "subscribe": {
      joinRoom(state, ws, (payload as ControlEvents["subscribe"]).topic);
      break;
    }
    case "unsubscribe": {
      leaveRoom(state, ws, (payload as ControlEvents["unsubscribe"]).topic);
      break;
    }
    case "joinGroup": {
      joinGroup(state, ws, (payload as ControlEvents["joinGroup"]).group);
      break;
    }
    case "leaveGroup": {
      leaveGroup(state, ws, (payload as ControlEvents["leaveGroup"]).group);
      break;
    }
    case "ping": {
      sendControl(state, ws, "pong", { ts: (payload as ControlEvents["ping"]).ts });
      break;
    }
    case "pong":
      // client keepalive reply — tracked on the client side (heartbeat)
      break;
    case "snapshotRequest":
      // per-topic replay from the ring buffer (see replay.ts)
      break;
  }
}
