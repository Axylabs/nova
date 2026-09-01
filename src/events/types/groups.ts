/**
 * Group handle types — client groups (by connection id) and user groups
 * (by userId).
 *
 * Type-only module (part of the `src/events/types` barrel). The runtime lives
 * in `src/events/groups.ts`.
 */
import type { Bindings, DefaultBindings, EventNameOf, EventsOf } from "../../bindings/types";

/** A named client group: membership by connection id, fan-out via the hub. */
export interface ClientGroup<B extends Bindings = DefaultBindings> {
  readonly name: string;
  /** add a connection (by id) to the group (idempotent) */
  add(clientId: string): void;
  remove(clientId: string): void;
  has(clientId: string): boolean;
  /** member connection ids */
  members(): string[];
  readonly size: number;
  /** emit an event to every member of this group (cluster-aware) */
  emit<K extends EventNameOf<B>>(name: K, payload: EventsOf<B>[K]): void;
}

/** A named USER group: membership by `userId`, fan-out to every socket of each member user. */
export interface UserGroup<B extends Bindings = DefaultBindings> {
  readonly name: string;
  add(userId: string): void;
  remove(userId: string): void;
  has(userId: string): boolean;
  /** member user ids */
  members(): string[];
  readonly size: number;
  /** emit an event to every socket acting on behalf of each member user */
  emit<K extends EventNameOf<B>>(name: K, payload: EventsOf<B>[K]): void;
}
