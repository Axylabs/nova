/**
 * Bun messaging server entry: all portable messaging APIs plus the optional
 * Rust-native codec for high-throughput service handlers and SSE producers.
 */
export * from "../src/messaging";
export { createNativeMessageCodec } from "../src/messaging/native";
