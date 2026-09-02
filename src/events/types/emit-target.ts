/**
 * Emit target — the discriminated union that addresses an emit.
 *
 * Type-only module (part of the `src/events/types` barrel). The delivery
 * runtime lives in `src/events/emit.ts`.
 */

/**
 * Where an emit goes. The discriminated union is how the API "easily
 * differentiates" between the addressing modes:
 *
 *   - `{ type: "broadcast" }` — every connected client, on every instance.
 *   - `{ type: "topic", topic }` — subscribers of a topic (rooms + replay).
 *   - `{ type: "group", group }` — members of a server-side group.
 *   - `{ type: "user", userId }` — every socket acting on behalf of `userId`.
 *   - `{ type: "user", userId, anywhere: true }` — same, but ALWAYS fanned out
 *     to every instance/service in the cluster mesh (ignores presence routing), so
 *     the user is reached no matter which instance holds their socket.
 *   - `{ type: "client", clientId }` — one specific connection.
 *
 * Local delivery is synchronous and allocation-free (the transport scratch +
 * `ws.send` copy); the cross-instance fan-out (when a cluster is configured)
 * is deferred to the offload queue so the emit call never blocks.
 */
export type EmitTarget =
  | { type: "broadcast" }
  | { type: "topic"; topic: string }
  | { type: "group"; group: string }
  | { type: "user"; userId: string; anywhere?: true }
  | { type: "client"; clientId: string };

export type EmitTargetKind = EmitTarget["type"];
