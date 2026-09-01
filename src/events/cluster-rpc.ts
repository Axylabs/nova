/**
 * Cross-instance RPC — request/response between hub instances over the
 * {@link ClusterTransport} (NATS / Redis / custom). Complements the WS-level
 * `client.request` ⇄ `server.handle` path: THIS layer is server ⇄ server,
 * e.g. "instance A, what is your live client count?" or "run this against the
 * instance holding user u-42's socket".
 *
 * Wire format: a small JSON envelope (this is an admin/control path, never
 * the WS hot path):
 *   { v: 1, t: "req" | "res", id, from, method, args?, ok?, err?, result? }
 *
 * Subjects: `{prefix}.cluster.rpc.{instanceId}` (targeted) and
 * `{prefix}.cluster.rpc.any` (any-instance calls — every instance receives
 * the request; the FIRST response wins and later ones are ignored).
 *
 * All transport work runs through the offload queue contract: publish() is
 * sync-but-cheap on the transport, subscriptions deliver on the broker's
 * callbacks; pending calls carry their own timeout so a dead instance can
 * never hang a caller beyond it.
 */
import type { ClusterTransport } from "./types";

const enc = new TextEncoder();
const dec = new TextDecoder();

interface RpcRequest {
  v: 1;
  t: "req";
  id: string;
  from: string;
  method: string;
  args: unknown;
}
interface RpcResponse {
  v: 1;
  t: "res";
  id: string;
  from: string;
  ok: boolean;
  err?: string;
  result?: unknown;
}
type RpcMessage = RpcRequest | RpcResponse;

export type RpcMethodHandler = (args: unknown, fromInstanceId: string) => unknown | Promise<unknown>;

export interface ClusterRpc {
  /**
   * Call `method` on ONE instance (`instanceId`) or on any instance
   * (omit → `{prefix}.cluster.rpc.any`; first response wins). Rejects on
   * timeout (`timeoutMs`, default 5000) with no response.
   */
  call(method: string, args?: unknown, opts?: { readonly instanceId?: string; readonly timeoutMs?: number }): Promise<unknown>;
  /** register a method handler (last registration wins) */
  on(method: string, handler: RpcMethodHandler): void;
  /** registered method names */
  methods(): string[];
  stats(): { sent: number; received: number; timeouts: number; errors: number };
  close(): void;
}

export interface ClusterRpcOptions {
  instanceId: string;
  prefix: string;
  transport: ClusterTransport;
}

export function createClusterRpc(opts: ClusterRpcOptions): ClusterRpc {
  const base = `${opts.prefix}.cluster.rpc`;
  const selfSubject = `${base}.${opts.instanceId}`;
  const anySubject = `${base}.any`;
  const handlers = new Map<string, RpcMethodHandler>();
  const pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  let sent = 0;
  let received = 0;
  let timeouts = 0;
  let errors = 0;

  const post = (msg: RpcMessage, subject: string): boolean => {
    if (!opts.transport.connected) {
      errors++;
      return false;
    }
    try {
      opts.transport.publish(subject, enc.encode(JSON.stringify(msg)));
      return true;
    } catch {
      errors++;
      return false;
    }
  };

  const handleMessage = (data: Uint8Array): void => {
    let msg: RpcMessage | null = null;
    try {
      msg = JSON.parse(dec.decode(data)) as RpcMessage;
    } catch {
      return;
    }
    if (!msg || msg.v !== 1) return;
    if (msg.t === "req") {
      received++;
      const handler = handlers.get(msg.method);
      if (!handler) return; // not ours — another instance answers (.any)
      void (async () => {
        try {
          const result = await handler(msg.args, msg.from);
          post(
            { v: 1, t: "res", id: msg.id, from: opts.instanceId, ok: true, result },
            `${base}.${msg.from}`,
          );
        } catch (err) {
          post(
            {
              v: 1,
              t: "res",
              id: msg.id,
              from: opts.instanceId,
              ok: false,
              err: err instanceof Error ? err.message : String(err),
            },
            `${base}.${msg.from}`,
          );
        }
      })();
      return;
    }
    // response — first one wins for .any fan-in
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(`ignex cluster rpc failed: ${msg.err ?? "unknown error"}`));
  };

  const unsubs = [opts.transport.subscribe(selfSubject, handleMessage), opts.transport.subscribe(anySubject, handleMessage)];

  return {
    call(method, args, rpcOpts) {
      const timeoutMs = rpcOpts?.timeoutMs ?? 5_000;
      const instanceId = rpcOpts?.instanceId;
      return new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        const timer = setTimeout(() => {
          if (!pending.has(id)) return;
          pending.delete(id);
          timeouts++;
          reject(new Error(`ignex cluster rpc "${method}" timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        const req: RpcRequest = {
          v: 1,
          t: "req",
          id,
          from: opts.instanceId,
          method,
          args,
        };
        if (!post(req, instanceId !== undefined ? `${base}.${instanceId}` : anySubject)) {
          clearTimeout(timer);
          pending.delete(id);
          reject(new Error("ignex cluster rpc: transport offline"));
          return;
        }
        sent++;
      });
    },
    on(method, handler) {
      handlers.set(method, handler);
    },
    methods() {
      return [...handlers.keys()];
    },
    stats() {
      return { sent, received, timeouts, errors };
    },
    close() {
      for (const u of unsubs)
        try {
          u();
        } catch {
          // already unsubscribed
        }
      for (const [, p] of pending) {
        clearTimeout(p.timer);
        p.reject(new Error("ignex cluster rpc: closed"));
      }
      pending.clear();
      handlers.clear();
    },
  };
}
