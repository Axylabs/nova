/**
 * Binary service-to-service messaging over a standard Request/Response seam.
 * The handler works in Bun routes, workers, tests, or any Fetch-compatible
 * adapter; the client works in browsers and Bun. No WebSocket is involved.
 */
import { defaultBindings } from "../bindings/default";
import type { Bindings, DefaultBindings, EventNameOf, EventsOf } from "../bindings/types";
import {
  createMessageCodec,
  NOVA_CONTENT_TYPE,
  type MessageCodec,
  type NovaMessage,
  type NovaMessageInput,
} from "./codec";

const DEFAULT_MAX_MESSAGE_SIZE = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

/** Read a Request/Response body with a hard byte bound, including chunked bodies. */
export async function readLimitedBody(
  message: Request | Response,
  maxBytes: number,
): Promise<Uint8Array | null> {
  const contentLength = message.headers.get("content-length");
  const declared = Number(contentLength ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (message.body === null) return new Uint8Array();
  if (contentLength !== null) {
    // Normal HTTP requests carry a parser-enforced length. Avoid the generic
    // reader/chunk/copy path, then verify the actual bytes before decoding.
    const body = await message.arrayBuffer();
    return body.byteLength > maxBytes ? null : new Uint8Array(body);
  }
  const reader = message.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** Message delivered to a binary service handler. */
export type ServiceMessage<B extends Bindings = DefaultBindings> = NovaMessage<B>;

/** Return a reply event, a custom Response, or nothing for a 204 response. */
export type ServiceHandlerResult<B extends Bindings = DefaultBindings> =
  | void
  | NovaMessageInput<B>
  | Response;

/** Binary service handler configuration. */
export interface ServiceHandlerOptions<B extends Bindings = DefaultBindings> {
  /** Generated bindings; ignored when `codec` is supplied. */
  bindings?: B;
  /** Pure-JS or native message codec. */
  codec?: MessageCodec<B>;
  /** Maximum request frame size, default 1 MiB. */
  maxMessageSize?: number;
  /** Optional request guard; a Response is returned verbatim. */
  authenticate?: (req: Request) => boolean | Response | Promise<boolean | Response>;
  /** Process one validated application event. */
  onMessage: (
    message: ServiceMessage<B>,
    req: Request,
  ) => ServiceHandlerResult<B> | Promise<ServiceHandlerResult<B>>;
  /** Handler failures are reported here and hidden from remote callers. */
  onError?: (err: Error) => void;
}

const text = (body: string, status: number, headers?: HeadersInit): Response =>
  new Response(body, { status, ...(headers !== undefined ? { headers } : {}) });

const acceptsNova = (contentType: string | null): boolean => {
  const media = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  return media === NOVA_CONTENT_TYPE || media === "application/octet-stream";
};

/** Create a bounded binary Request/Response handler from a Nova contract. */
export function createServiceHandler<B extends Bindings = DefaultBindings>(
  options: ServiceHandlerOptions<B>,
): (req: Request) => Promise<Response> {
  const codec = options.codec ?? createMessageCodec(options.bindings ?? (defaultBindings as unknown as B));
  const maxBytes = Math.max(1, options.maxMessageSize ?? DEFAULT_MAX_MESSAGE_SIZE);
  return async (req) => {
    if (req.method !== "POST") return text("method not allowed", 405, { allow: "POST" });
    if (!acceptsNova(req.headers.get("content-type"))) {
      return text(`expected ${NOVA_CONTENT_TYPE}`, 415);
    }
    if (options.authenticate !== undefined) {
      try {
        const allowed = await options.authenticate(req);
        if (allowed instanceof Response) return allowed;
        if (!allowed) return text("unauthorized", 401);
      } catch {
        return text("unauthorized", 401);
      }
    }
    const body = await readLimitedBody(req, maxBytes);
    if (body === null) return text("message too big", 413);
    const message = codec.decode(body);
    if (message === null) return text("invalid Nova application frame", 400);
    try {
      const result = await options.onMessage(message, req);
      if (result instanceof Response) return result;
      if (result === undefined) return new Response(null, { status: 204 });
      const frame = codec.encode(result.name, result.payload);
      return new Response(frame as Uint8Array<ArrayBuffer>, {
        headers: { "content-type": NOVA_CONTENT_TYPE },
      });
    } catch (err) {
      options.onError?.(err instanceof Error ? err : new Error(String(err)));
      return text("Nova service handler failed", 500);
    }
  };
}

/** Binary service client configuration. */
export interface ServiceClientOptions<B extends Bindings = DefaultBindings> {
  /** Generated bindings shared with the remote service. */
  bindings?: B;
  /** Injectable Request-based fetch implementation (tests, agents, runtimes). */
  fetch?: FetchImplementation;
  /** Static or per-request headers, useful for service credentials. */
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  /** Additional fetch options that do not replace Nova's method/body/signal. */
  request?: Omit<RequestInit, "method" | "headers" | "body" | "signal">;
  /** Abort every in-flight request when this signal fires. */
  signal?: AbortSignal;
  /** Round-trip timeout, default 10 seconds; 0 disables it. */
  timeoutMs?: number;
  /** Maximum binary response size, default 1 MiB. */
  maxMessageSize?: number;
}

/** Typed client for a binary Nova service endpoint. */
export interface ServiceClient<B extends Bindings = DefaultBindings> {
  /** Send an event and expect a 204 or other successful empty response. */
  send<K extends EventNameOf<B>>(name: K, payload: EventsOf<B>[K]): Promise<void>;
  /** Send an event and decode a same-event response payload. */
  call<K extends EventNameOf<B>>(name: K, payload: EventsOf<B>[K]): Promise<EventsOf<B>[K]>;
}

/** Minimal Request-based fetch contract shared by clients and handlers. */
export type FetchImplementation = (request: Request) => Promise<Response>;

const serviceError = (message: string, status?: number): Error =>
  Object.assign(new Error(message), status !== undefined ? { status } : {});

/** Create a typed binary service client. */
export function createServiceClient<B extends Bindings = DefaultBindings>(
  url: string | URL,
  options: ServiceClientOptions<B> = {},
): ServiceClient<B> {
  const codec = createMessageCodec(options.bindings ?? (defaultBindings as unknown as B));
  const fetchImpl = options.fetch ?? fetch;
  const maxBytes = Math.max(1, options.maxMessageSize ?? DEFAULT_MAX_MESSAGE_SIZE);

  const post = async <K extends EventNameOf<B>>(
    name: K,
    payload: EventsOf<B>[K],
  ): Promise<Response> => {
    const extra = typeof options.headers === "function" ? await options.headers() : options.headers;
    const headers = new Headers(extra);
    headers.set("content-type", NOVA_CONTENT_TYPE);
    headers.set("accept", NOVA_CONTENT_TYPE);
    const controller = new AbortController();
    const abort = (): void => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
    try {
      return await fetchImpl(new Request(url, {
        ...options.request,
        method: "POST",
        headers,
        body: codec.encode(name, payload) as Uint8Array<ArrayBuffer>,
        signal: controller.signal,
      }));
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  };

  return {
    async send(name, payload) {
      const response = await post(name, payload);
      if (!response.ok) throw serviceError(`Nova service returned HTTP ${response.status}`, response.status);
      await response.body?.cancel();
    },
    async call<K extends EventNameOf<B>>(name: K, payload: EventsOf<B>[K]) {
      const response = await post(name, payload);
      if (!response.ok) throw serviceError(`Nova service returned HTTP ${response.status}`, response.status);
      const body = await readLimitedBody(response, maxBytes);
      if (body === null) throw serviceError("Nova service response exceeded the configured limit", 413);
      const message = codec.decode(body);
      if (message === null || message.name !== name) {
        throw serviceError("Nova service returned an invalid or mismatched event", 502);
      }
      return message.payload as EventsOf<B>[K];
    },
  };
}
