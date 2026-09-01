/**
 * Client RPC — the request/response half of `client.request(name, payload)`.
 *
 * Extracted from the client composition root so the wire-level plumbing
 * (base64 framing, pending-call registry, timeout bookkeeping) lives in one
 * small module. The reply side (`rpcResult` handling) is in `client-wire.ts`.
 */
import type { Bindings } from "../bindings/types";
import { sendControl } from "./client-wire";
import type { ClientState } from "./client-state";

/** Encode bytes as base64 without pulling in a Buffer dependency (browser-safe). */
export function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.byteLength; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

/** Reject every pending rpc call (client close / socket loss). */
export function failAllPending(
  state: ClientState,
  err: Error,
): void {
  for (const [id, call] of state.rpcPending) {
    clearTimeout(call.timer);
    call.reject(err);
    state.rpcPending.delete(id);
  }
}

/**
 * Run a request/response round-trip: encode `payload` with the event's own
 * schema, send it inside an `rpcCall` control frame, and settle with
 * `{ payload }` from the responder. Rejects on timeout, transport loss, or a
 * server-side error — never leaves a pending entry behind.
 */
export function createRpcRequest<B extends Bindings>(
  state: ClientState,
  name: string,
  payload: unknown,
  opts: { readonly timeoutMs?: number } | undefined,
  bindings: B,
): Promise<unknown> {
  const ws = state.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN)
    return Promise.reject(new Error("ignex: client is not connected"));

  const id = crypto.randomUUID();
  const inner = bindings.encodeFrame(name, payload);
  const b64 = bytesToB64(inner);
  const timeoutMs = opts?.timeoutMs ?? state.requestTimeoutMs;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.rpcPending.delete(id);
      reject(new Error(`ignex rpc "${name}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    // registered BEFORE the send so a fast reply can never race the insert
    state.rpcPending.set(id, {
      name,
      // the wire resolves with the bare payload — wrap it into RpcResult here
      resolve: (out) => resolve({ payload: out }),
      reject,
      timer,
    });
    try {
      sendControl(state, "rpcCall", { id, name, payloadB64: b64 });
    } catch (err) {
      clearTimeout(timer);
      state.rpcPending.delete(id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
