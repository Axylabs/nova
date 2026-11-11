/** Bun-native codec for binary handlers and other server-side transports. */
import type { Bindings, DefaultBindings } from "../bindings/types";
import { createTransport } from "../transport/transport";
import { createMessageCodec, type MessageCodec } from "./codec";

/** Encode service messages through Nova's direct Rust/JSON transport. */
export function createNativeMessageCodec<B extends Bindings = DefaultBindings>(
  bindings: B,
): MessageCodec<B> {
  const transport = createTransport(bindings);
  return createMessageCodec(bindings, (name, payload) => transport.encodeEvent(name, payload));
}
