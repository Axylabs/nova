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
import type { ControlEventName, ControlEvents } from "../schema";
import { capturePayload } from "../events/trace";
import { sendControl, doSend } from "./outbound";
import { replayAfter } from "./resume";
import { joinRoom, leaveRoom } from "./rooms";
import { topicHistoryFrom } from "./replay";
import { joinGroup, leaveGroup } from "./groups";
import { createRateLimiter } from "./rate-limit";
import type { ServerState, WsData } from "./state";

// allocated once per process, reused for every inbound text frame
const textEncoder = new TextEncoder();

export function handleMessage(
  state: ServerState,
  ws: ServerWebSocket<WsData>,
  raw: string | Buffer,
): void {
  // cheap oversize pre-check BEFORE any conversion work (string length is a
  // lower bound of its UTF-8 size, so `>` here can never false-positive)
  if (state.maxMessageSize !== undefined) {
    const approx = typeof raw === "string" ? raw.length : raw.byteLength;
    if (approx > state.maxMessageSize) {
      state.metrics.protocolErrors++;
      ws.close(1009, "message too big");
      return;
    }
  }
  // binary frames are viewed ZERO-COPY (decode is synchronous and every
  // downstream holder — replay history, backpressure queue, NATS bridge —
  // takes its own owned copy); only text frames pay one transcode.
  const bytes =
    typeof raw === "string"
      ? textEncoder.encode(raw)
      : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  if (state.maxMessageSize !== undefined && bytes.byteLength > state.maxMessageSize) {
    // multi-byte text frames can exceed the lower bound checked above
    state.metrics.protocolErrors++;
    ws.close(1009, "message too big");
    return;
  }
  // per-connection token bucket — evaluated before ANY decode work so a
  // flooding client is shed at ~constant cost (app AND control frames).
  const rl = state.rateLimit;
  if (rl !== null) {
    let limiter = ws.data.rate;
    if (limiter === undefined) {
      limiter = createRateLimiter(rl);
      ws.data.rate = limiter;
    }
    if (!limiter.allow(Date.now())) {
      state.metrics.rateLimited++;
      if (limiter.policy === "close") ws.close(1008, "rate limit exceeded");
      return;
    }
  }
  const header = state.bindings.readFrameHeader(bytes);
  if (!header) {
    state.metrics.protocolErrors++;
    return; // undecodable / wrong version / unknown id — drop
  }
  if (state.bindings.isControlId(header.id)) {
    state.metrics.inboundControl++;
    handleControl(state, ws, header.name as ControlEventName, state.bindings.decodePayload(header.id, bytes) as never);
    return;
  }
  const name = header.name;
  if (!state.inbound.has(name)) return; // not an allowed inbound event — no payload decode
  state.metrics.inbound++;
  // trace: one row per accepted client event (the debugger's "what came in").
  // The payload itself is materialized only when somebody consumes it (a
  // handler exists or capture is on) — never allocated otherwise.
  const handler = state.inboundHandlers.get(name);
  const payload =
    handler !== undefined || state.trace.captures
      ? state.bindings.decodePayload(header.id, bytes)
      : undefined;
  state.trace.record(
    "in.client",
    name,
    undefined,
    ws.data.id,
    bytes.byteLength,
    state.trace.captures ? capturePayload(payload, 2000) : undefined,
  );
  handler?.(payload, ws);
  // Horizontal scaling: when the bridge is configured with `bridgeClientEvents`,
  // every accepted client event is re-published to `{prefix}.inbound.<event>` so
  // OTHER server instances (and BE consumers) receive it. NATS-inbound frames
  // arrive via `onInbound` → `fanOutAll` (never through this path), so there is
  // no loop; this server's own clients are re-delivered exactly once through its
  // own inbound subscription (the app handler should therefore not ALSO
  // broadcast, or the event would be delivered twice locally).
  if (state.bridge?.clientEvents) {
    state.bridge.publish(state.bridge.subjects.inboundEvent(name), bytes);
  }
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
      if (p.version !== state.bindings.wireVersion) {
        // protocol version mismatch — refuse this client
        ws.close(1002, "wire version mismatch");
        break;
      }
      // cross-session resume: the client reconnects with `lastSeq > 0` and a
      // parked history was adopted for its id (server.open wires adoption).
      if (p.lastSeq > 0 && ws.data.history !== undefined && ws.data.history.length > 0) {
        const r = replayAfter(state, ws, p.lastSeq);
        state.metrics.resumesServed++;
        state.metrics.framesReplayed += r.replayed;
        if (!r.ok) state.metrics.resumeMisses++;
        sendControl(state, ws, "resumed", { ok: r.ok, from: r.from });
      }
      break;
    }
    case "resume": {
      // same-connection gap recovery: replay everything after the client's
      // last contiguous seq (original seqs preserved — no re-stamping)
      const lastSeq = (payload as ControlEvents["resume"]).lastSeq;
      const r = replayAfter(state, ws, lastSeq);
      state.metrics.resumesServed++;
      state.metrics.framesReplayed += r.replayed;
      if (!r.ok) state.metrics.resumeMisses++;
      sendControl(state, ws, "resumed", { ok: r.ok, from: r.from });
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
    case "snapshotRequest": {
      // per-topic replay from the ring buffer (+ topic log when configured),
      // strictly after `fromSeq` (0 = from the beginning of retained history)
      const p = payload as ControlEvents["snapshotRequest"];
      for (const frame of topicHistoryFrom(state, p.topic, p.fromSeq)) doSend(state, ws, frame);
      break;
    }
    case "rpcCall": {
      const p = payload as ControlEvents["rpcCall"];
      const responder = state.rpcHandlers.get(p.name);
      const reply = (ok: boolean, payloadB64: string, err = ""): void => {
        sendControl(state, ws, "rpcResult", { id: p.id, ok, err, payloadB64 });
      };
      if (!responder) {
        reply(false, "", `no handler for "${p.name}"`);
        return;
      }
      const inner = decodeB64Frame(state, p.payloadB64);
      if (!inner) {
        reply(false, "", "undecodable request payload");
        return;
      }
      void (async () => {
        try {
          const out = await responder(inner.payload, ws);
          // encode with the SAME event name (request/response share a schema)
          const frame = state.transport.encodeToScratch(p.name, out);
          reply(true, b64(frame));
        } catch (err) {
          reply(false, "", err instanceof Error ? err.message : String(err));
        }
      })();
      break;
    }
  }
}

/** Decode a base64 wire frame (rpcCall payload) into { name, payload }. */
function decodeB64Frame(
  state: ServerState,
  b64: string,
): { name: string; payload: unknown } | null {
  try {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return state.bindings.decodeFrame(bytes) as { name: string; payload: unknown } | null;
  } catch {
    return null;
  }
}

const b64 = (bytes: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < bytes.byteLength; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
};
