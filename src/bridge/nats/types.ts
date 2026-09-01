/**
 * NATS bridge contracts — options, stats, and the transport/bridge surfaces.
 *
 * Type + contract module: the runtime lives in `real-transport.ts` (the
 * eager connection) and `index.ts` (the bridge itself).
 */
import type { SubjectBuilder } from "../subjects";
import type { Bindings } from "../../bindings/types";

export type NatsBridgeStatus = "connected" | "connecting" | "closed";

export interface NatsBridgeOptions {
  /** NATS servers, default ["nats://localhost:4222"] */
  servers?: string[];
  /** subject prefix, default "ignex" (or the bindings' subjectPrefix) */
  subjectPrefix?: string;
  /**
   * The wire stack used to decode inbound frames (default: built-in registry).
   * Pass your own generated bindings so the bridge decodes YOUR events.
   */
  bindings?: Bindings;
  /** connect timeout (ms), default 5000 */
  connectTimeout?: number;
  /** how long to wait before retrying a failed initial connect (ms), default 2000 */
  connectRetryMs?: number;
  /** reconnect handled by nats.js (core NATS, no durable queues), default true */
  reconnect?: boolean;
  /** optional NATS token (auth) */
  token?: string;
  /** subscribe to inbound subjects and forward events to clients, default false */
  inbound?: boolean;
  /** inbound subjects (default `{prefix}.inbound.>`), requires `inbound` */
  inboundSubjects?: string[];
  /** only forward these inbound events (default: every app event) */
  inboundEvents?: string[];
  /**
   * Re-publish every accepted client-sent event to `{prefix}.inbound.<event>`
   * so other servers in the cluster (and BE consumers) receive it, default
   * false. See the horizontal-scaling docs.
   */
  bridgeClientEvents?: boolean;
}

/** Counters folded into `server.getMetrics()`. */
export interface NatsBridgeStats {
  bridged: number;
  bridgedBytes: number;
  bridgeErrors: number;
  bridgeInbound: number;
  bridgeInboundErrors: number;
}

/** Minimal transport — a real NATS connection or a test fake. */
export interface NatsTransport {
  readonly connected: boolean;
  /** synchronously send bytes; throws when not connected (bridge catches + counts) */
  publish(subject: string, data: Uint8Array): void;
  /** subscribe; `cb` receives message bytes; returns an unsubscribe function */
  subscribe(subject: string, cb: (data: Uint8Array) => void): () => void;
  close(): Promise<void>;
}

export interface NatsBridge {
  readonly status: NatsBridgeStatus;
  readonly subjects: SubjectBuilder;
  readonly stats: NatsBridgeStats;
  /** whether client-sent events are re-published to `{prefix}.inbound.<event>` */
  readonly clientEvents: boolean;
  /** publish a frame to `subject` (copies the bytes — safe after scratch reuse) */
  publish(subject: string, frame: Uint8Array): void;
  /**
   * Raw byte subscription (used by the events cluster layer). Unlike the
   * inbound path this does NOT decode or forward — bytes are handed to `cb`
   * verbatim, re-subscribed automatically after a NATS reconnect.
   */
  subscribeRaw(subject: string, cb: (data: Uint8Array) => void): () => void;
  /** wire the inbound → clients forward (set once by the server) */
  setOnInbound(cb: (name: string, payload: unknown) => void): void;
  close(): Promise<void>;
}
