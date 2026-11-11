/**
 * Transport-neutral Nova messages. A codec is the same generated wire contract
 * used by WebSockets and NATS; HTTP, SSE, queues, and files are just carriers.
 */
import { defaultBindings } from "../bindings/default";
import type { Bindings, DefaultBindings, EventNameOf, EventsOf } from "../bindings/types";

/** Binary media type for one complete Nova frame. */
export const NOVA_CONTENT_TYPE = "application/vnd.ignex.nova";

/** A decoded application event and the owned frame it arrived in. */
export type NovaMessage<B extends Bindings = DefaultBindings> = {
  [K in EventNameOf<B>]: { name: K; payload: EventsOf<B>[K]; frame: Uint8Array };
}[EventNameOf<B>];

/** A typed event input accepted by service handlers. */
export type NovaMessageInput<B extends Bindings = DefaultBindings> = {
  [K in EventNameOf<B>]: { name: K; payload: EventsOf<B>[K] };
}[EventNameOf<B>];

/** Encode and decode application events independently of their transport. */
export interface MessageCodec<B extends Bindings = DefaultBindings> {
  readonly bindings: B;
  encode<K extends EventNameOf<B>>(name: K, payload: EventsOf<B>[K]): Uint8Array;
  decode(frame: Uint8Array): NovaMessage<B> | null;
}

/** Create a codec over generated bindings, with an optional native encoder. */
export function createMessageCodec<B extends Bindings = DefaultBindings>(
  bindings: B = defaultBindings as unknown as B,
  encodeFrame: (name: string, payload: unknown) => Uint8Array = bindings.encodeFrame,
): MessageCodec<B> {
  return {
    bindings,
    encode(name, payload) {
      return encodeFrame(name, payload);
    },
    decode(frame) {
      const decoded = bindings.decodeFrame(frame);
      if (decoded === null || bindings.isControlId(decoded.id)) return null;
      return {
        name: decoded.name as EventNameOf<B>,
        payload: decoded.payload as EventsOf<B>[EventNameOf<B>],
        frame,
      };
    },
  };
}
