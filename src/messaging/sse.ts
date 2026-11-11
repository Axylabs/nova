/**
 * Nova over Server-Sent Events. Each SSE `data` record carries base64 of one
 * complete Nova frame; `event` mirrors its schema name for standard tooling.
 * The binary frame, not the SSE text, remains authoritative for validation.
 */
import { defaultBindings } from "../bindings/default";
import type { Bindings, DefaultBindings } from "../bindings/types";
import { base64ToBytes, bytesToBase64 } from "./base64";
import { createMessageCodec, type NovaMessage } from "./codec";
import type { FetchImplementation } from "./http";

const textEncoder = new TextEncoder();
const DEFAULT_MAX_MESSAGE_SIZE = 1024 * 1024;

/** Optional SSE metadata accompanying a Nova frame. */
export interface NovaSseMetadata {
  id?: string;
  retry?: number;
}

/** A frame or a frame with per-event SSE metadata. */
export type NovaSseFrame = Uint8Array | ({ frame: Uint8Array } & NovaSseMetadata);

/** A decoded Nova event plus its SSE metadata. */
export type NovaSseMessage<B extends Bindings = DefaultBindings> = NovaMessage<B> & NovaSseMetadata;

const validField = (value: string): boolean =>
  !value.includes("\r") && !value.includes("\n") && !value.includes("\0");

/** Encode one complete Nova frame as a standards-compliant SSE event. */
export function encodeSseEvent<B extends Bindings = DefaultBindings>(
  input: NovaSseFrame,
  bindings: B = defaultBindings as unknown as B,
): Uint8Array {
  const frame = input instanceof Uint8Array ? input : input.frame;
  const header = bindings.readFrameHeader(frame);
  if (header === null || bindings.isControlId(header.id) || !validField(header.name)) {
    throw new Error("Nova SSE requires a valid application frame and single-line event name");
  }
  const metadata: NovaSseMetadata = input instanceof Uint8Array ? {} : input;
  if (metadata.id !== undefined && !validField(metadata.id)) {
    throw new Error("Nova SSE id cannot contain newlines or NUL");
  }
  if (metadata.retry !== undefined && (!Number.isSafeInteger(metadata.retry) || metadata.retry < 0)) {
    throw new Error("Nova SSE retry must be a non-negative safe integer");
  }
  const lines = [`event: ${header.name}`];
  if (metadata.id !== undefined) lines.push(`id: ${metadata.id}`);
  if (metadata.retry !== undefined) lines.push(`retry: ${metadata.retry}`);
  lines.push(`data: ${bytesToBase64(frame)}`, "");
  return textEncoder.encode(`${lines.join("\n")}\n`);
}

/** Decode one SSE event block, rejecting event/frame confusion and bad wire data. */
export function decodeSseEvent<B extends Bindings = DefaultBindings>(
  block: string,
  bindings: B = defaultBindings as unknown as B,
): NovaSseMessage<B> | null {
  let eventName = "";
  let id: string | undefined;
  let retry: number | undefined;
  const data: string[] = [];
  for (const line of block.split(/\r\n|\r|\n/)) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") eventName = value;
    else if (field === "id" && !value.includes("\0")) id = value;
    else if (field === "retry" && /^\d+$/.test(value)) retry = Number(value);
  }
  if (data.length === 0) return null;
  const message = createMessageCodec(bindings).decode(base64ToBytes(data.join("")));
  if (message === null) throw new Error("Nova SSE data is not a valid application frame");
  if (eventName !== "" && eventName !== message.name) {
    throw new Error(`Nova SSE event "${eventName}" does not match frame event "${message.name}"`);
  }
  return {
    ...message,
    ...(id !== undefined ? { id } : {}),
    ...(retry !== undefined ? { retry } : {}),
  };
}

/** Options for incremental SSE decoding. */
export interface NovaSseReadOptions<B extends Bindings = DefaultBindings> {
  bindings?: B;
  /** Maximum decoded Nova frame size, default 1 MiB. */
  maxMessageSize?: number;
}

/** Read Nova events from a byte stream or fetch Response, including split chunks. */
export async function* readNovaSse<B extends Bindings = DefaultBindings>(
  source: ReadableStream<Uint8Array> | Response,
  options: NovaSseReadOptions<B> = {},
): AsyncGenerator<NovaSseMessage<B>> {
  const bindings = options.bindings ?? (defaultBindings as unknown as B);
  const maxChars = Math.max(1, options.maxMessageSize ?? DEFAULT_MAX_MESSAGE_SIZE) * 2 + 1024;
  const stream = source instanceof Response ? source.body : source;
  if (stream === null) throw new Error("Nova SSE response has no body");
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let block = "";
  let done = false;

  const dispatch = function* (): Generator<NovaSseMessage<B>> {
    if (block === "") return;
    const current = block;
    block = "";
    const message = decodeSseEvent(current, bindings);
    if (message !== null) yield message;
  };

  try {
    for (;;) {
      if (!done) {
        const next = await reader.read();
        done = next.done;
        buffered += done ? decoder.decode() : decoder.decode(next.value, { stream: true });
      }
      if (buffered.length > maxChars && block.length === 0) {
        throw new Error("Nova SSE event exceeded the configured limit");
      }
      let progressed = false;
      for (;;) {
        const match = /[\r\n]/.exec(buffered);
        if (match === null) break;
        const index = match.index;
        const char = buffered[index];
        if (char === "\r" && index === buffered.length - 1 && !done) break;
        const width = char === "\r" && buffered[index + 1] === "\n" ? 2 : 1;
        const line = buffered.slice(0, index);
        buffered = buffered.slice(index + width);
        progressed = true;
        if (line === "") yield* dispatch();
        else {
          block += `${line}\n`;
          if (block.length > maxChars) throw new Error("Nova SSE event exceeded the configured limit");
        }
      }
      if (done) {
        if (buffered !== "") {
          block += buffered;
          buffered = "";
        }
        yield* dispatch();
        return;
      }
      if (!progressed && buffered.length > maxChars) {
        throw new Error("Nova SSE event exceeded the configured limit");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Options for an SSE streaming Response. */
export interface NovaSseResponseOptions<B extends Bindings = DefaultBindings> {
  bindings?: B;
  init?: ResponseInit;
  /** Stop the producer when this signal aborts or the consumer cancels. */
  signal?: AbortSignal;
}

/** Stream Nova frames as SSE with pull backpressure and producer cancellation. */
export function createSseResponse<B extends Bindings = DefaultBindings>(
  source: AsyncIterable<NovaSseFrame>,
  options: NovaSseResponseOptions<B> = {},
): Response {
  const bindings = options.bindings ?? (defaultBindings as unknown as B);
  const iterator = source[Symbol.asyncIterator]();
  const signal = options.signal;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
  let finished = false;

  const closeProducer = (): void => {
    try {
      const result = iterator.return?.();
      if (result) void result.catch(() => {});
    } catch {
      // Already closed.
    }
  };
  const finish = (error?: unknown): void => {
    if (finished) return;
    finished = true;
    signal?.removeEventListener("abort", onAbort);
    try {
      if (error === undefined) controllerRef?.close();
      else controllerRef?.error(error);
    } catch {
      // Cancellation and producer completion may race; both are terminal.
    }
  };
  const onAbort = (): void => {
    closeProducer();
    finish();
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    },
    async pull(controller) {
      if (finished) return;
      try {
        const next = await iterator.next();
        if (finished) return;
        if (next.done) {
          closeProducer();
          finish();
          return;
        }
        controller.enqueue(encodeSseEvent(next.value, bindings));
      } catch (err) {
        closeProducer();
        finish(err);
      }
    },
    cancel() {
      closeProducer();
      finish();
    },
  });

  const headers = new Headers({
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  new Headers(options.init?.headers).forEach((value, key) => headers.set(key, value));
  return new Response(stream, { ...options.init, headers });
}

/** Options for opening an SSE service stream. */
export interface OpenNovaSseOptions<B extends Bindings = DefaultBindings>
  extends NovaSseReadOptions<B> {
  fetch?: FetchImplementation;
  headers?: HeadersInit;
  signal?: AbortSignal;
}

/** An open SSE response, its typed events, and idempotent teardown. */
export interface OpenNovaSse<B extends Bindings = DefaultBindings> {
  response: Response;
  messages: AsyncGenerator<NovaSseMessage<B>>;
  close(): void;
}

/** Open and validate a fetch-based Nova SSE stream. */
export async function openNovaSse<B extends Bindings = DefaultBindings>(
  url: string | URL,
  options: OpenNovaSseOptions<B> = {},
): Promise<OpenNovaSse<B>> {
  const fetchImpl = options.fetch ?? fetch;
  const headers = new Headers(options.headers);
  headers.set("accept", "text/event-stream");
  const controller = new AbortController();
  const abort = (): void => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  const response = await fetchImpl(new Request(url, { headers, signal: controller.signal }));
  if (!response.ok || !response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) {
    options.signal?.removeEventListener("abort", abort);
    await response.body?.cancel();
    throw new Error(`Nova SSE endpoint returned HTTP ${response.status} or an invalid content type`);
  }
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    options.signal?.removeEventListener("abort", abort);
    controller.abort();
  };
  const messages = (async function* (): AsyncGenerator<NovaSseMessage<B>> {
    try {
      yield* readNovaSse(response, options);
    } finally {
      close();
    }
  })();
  return {
    response,
    messages,
    close: () => {
      if (closed) return;
      close();
      void messages.return(undefined);
    },
  };
}
