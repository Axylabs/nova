/**
 * HTTP routes — the non-WebSocket side of `Bun.serve`'s fetch: the upgrade
 * path, a JSON `/health` probe, an auth-gated `/clients` introspection
 * endpoint, and the user-supplied fallback.
 *
 * Each route is a small pure-ish function `(state, req) => Response | null`
 * (`null` = "not my route"); `handleHttpRequest` composes them in order.
 */
import type { ServerState, WsData } from "../state";
import { authorizeHttp, checkUpgrade } from "../auth";
import { toClientInfo } from "./client-info";

/** The Bun server handle (needed by `checkUpgrade` for `srv.upgrade`). */
type BunServer = ReturnType<typeof Bun.serve<WsData>>;

/** JSON response helper (the only shape these routes return). */
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    ...(status === 200 ? {} : { status }),
    headers: { "content-type": "application/json" },
  });

/** GET /health — liveness + basic counters (never gated; safe for probes). */
function healthRoute(state: ServerState): Response {
  const h = state.metrics.snapshot(state.sockets.size);
  return json({ status: "ok", clients: h.connectedClients, uptimeMs: h.uptimeMs });
}

/** GET /clients — active-client introspection. */
async function clientsRoute(state: ServerState, req: Request): Promise<Response> {
  // gated whenever the server has an auth surface (token or authenticate);
  // public only for unsecured servers
  const denied = await authorizeHttp(state, req);
  if (denied) return denied;
  return json([...state.clients.values()].map(toClientInfo));
}

/**
 * Route an HTTP request. Order matters:
 *   1. the WS upgrade path (`state.path`),
 *   2. built-in introspection endpoints,
 *   3. the user's custom `fetch` (when provided),
 *   4. 404.
 */
export async function handleHttpRequest(
  state: ServerState,
  req: Request,
  srv: BunServer,
  customFetch?: (req: Request) => Response | Promise<Response>,
): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === state.path) {
    return (await checkUpgrade(state, req, srv)) ?? new Response("upgrade failed", { status: 400 });
  }
  if (url.pathname === "/health") return healthRoute(state);
  if (url.pathname === "/clients") return clientsRoute(state, req);
  if (customFetch) return customFetch(req);
  return new Response("not found", { status: 404 });
}
