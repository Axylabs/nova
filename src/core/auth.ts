/**
 * Upgrade gate — pure-ish decision logic for who may open a WebSocket:
 * connection limit → origin allowlist → bearer token → custom `authenticate`.
 * Returns a `Response` to reject the upgrade, or `undefined` to allow it
 * (after calling `srv.upgrade`). Mirrors the former `IgnServer.tryUpgrade`.
 *
 * `authenticate` may return a `ClientMeta` (`{id, groups, meta}`) to pin the
 * client's identity for targeted sends / grouping; otherwise a UUID is
 * auto-assigned. A duplicate explicit id rejects the new connection (409).
 *
 * Literal bearer tokens are compared in CONSTANT TIME (no length or prefix
 * oracle for a brute-forcing caller). The same gate protects the HTTP admin
 * surface (`GET /clients`) via `authorizeHttp` — introspection endpoints must
 * never be wider than the WebSocket they introspect.
 */
import { timingSafeEqual } from "node:crypto";
import type { ClientMeta, ServerState, WsData } from "./state";

/** Constant-time string equality (UTF-8 compared; length-safe). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.byteLength !== bb.byteLength) {
    // burn comparable time so mismatched-length guesses aren't cheaper
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** Evaluate the server's token gate against a raw Bearer value. */
export function tokenOk(state: ServerState, bearer: string | null): boolean {
  if (state.token === undefined) return true;
  if (bearer === null || bearer === "") return false;
  try {
    return typeof state.token === "function" ? state.token(bearer) : safeEqual(bearer, state.token);
  } catch {
    return false; // a broken auth backend must deny, never escape the serve loop
  }
}

function bearerOf(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth === null || !auth.startsWith("Bearer ")) return null;
  return auth.slice("Bearer ".length);
}

/**
 * HTTP admin gate (defense-in-depth for non-WebSocket routes): when a `token`
 * is configured the request MUST carry a valid Bearer; otherwise, when an
 * `authenticate` hook exists it must accept the request. Unauthenticated
 * servers stay unauthenticated (documented dev behavior).
 */
export async function authorizeHttp(
  state: ServerState,
  req: Request,
): Promise<Response | undefined> {
  if (state.token !== undefined || state.authenticate !== undefined) {
    if (!tokenOk(state, bearerOf(req))) return new Response("unauthorized", { status: 401 });
    if (state.token === undefined && state.authenticate !== undefined) {
      // a failing auth backend must deny, not blow up the serve loop
      let allowed: unknown;
      try {
        allowed = await state.authenticate(req);
      } catch {
        return new Response("unauthorized", { status: 401 });
      }
      if (!allowed) return new Response("unauthorized", { status: 401 });
    }
  }
  return undefined;
}

export async function checkUpgrade(
  state: ServerState,
  req: Request,
  srv: ReturnType<typeof Bun.serve<WsData>>,
): Promise<Response | undefined> {
  if (
    state.maxConnections !== undefined &&
    state.sockets.size + state.pendingUpgrades >= state.maxConnections
  ) {
    return new Response("too many connections", { status: 503 });
  }
  if (state.maxConnections !== undefined) state.pendingUpgrades++;
  let upgraded = false;
  try {
    if (state.allowedOrigins) {
      const origin = req.headers.get("origin") ?? "";
      if (!state.allowedOrigins.includes(origin)) {
        return new Response("origin not allowed", { status: 403 });
      }
    }
    if (state.token !== undefined && !tokenOk(state, bearerOf(req))) {
      return new Response("unauthorized", { status: 401 });
    }
    let authMeta: ClientMeta | undefined;
    if (state.authenticate) {
      // a throwing / rejecting hook denies the upgrade cleanly (401) instead of
      // surfacing an unhandled error through Bun.serve's fetch loop
      let res: Awaited<ReturnType<typeof state.authenticate>>;
      try {
        res = await state.authenticate(req);
      } catch {
        return new Response("unauthorized", { status: 401 });
      }
      if (!res) return new Response("unauthorized", { status: 401 });
      if (typeof res === "object") authMeta = res;
    }
    // identity: explicit id from auth, else a fresh UUID. Duplicate ids are
    // rejected up-front (an admin can `disconnectClient` the stale session).
    const id = authMeta?.id ?? crypto.randomUUID();
    if (state.clients.has(id)) {
      return new Response("client id already in use", { status: 409 });
    }
    const data: WsData = {
      lastSeq: 0,
      sendSeq: 1,
      rpcInFlight: 0,
      topics: new Set(),
      groups: new Set(authMeta?.groups ?? []),
      id,
      ...(authMeta?.userId !== undefined ? { userId: authMeta.userId } : {}),
      ...(authMeta?.meta !== undefined ? { meta: authMeta.meta } : {}),
      connectedAt: Date.now(),
    };
    // bun-types requires the WebSocketData options arg when Data != undefined
    if (srv.upgrade(req, { data })) {
      upgraded = true; // onSocketOpen releases the reservation
      return undefined;
    }
    return new Response("upgrade failed", { status: 400 });
  } finally {
    if (!upgraded && state.maxConnections !== undefined) state.pendingUpgrades--;
  }
}
