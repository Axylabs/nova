/**
 * NATS cluster transport — wraps the server's (or a dedicated) NATS bridge as
 * a {@link ClusterTransport}. The owning bridge decides its own lifecycle;
 * this adapter only adapts the surface.
 */
import type { NatsBridge } from "../../bridge/nats";
import type { ClusterTransport } from "../types";

export function createNatsClusterTransport(bridge: NatsBridge): ClusterTransport {
  return {
    get connected(): boolean {
      return bridge.status === "connected";
    },
    publish(subject, data) {
      bridge.publish(subject, data); // copies bytes + counts bridge stats
    },
    subscribe(subject, cb) {
      return bridge.subscribeRaw(subject, cb);
    },
    close() {
      return Promise.resolve(); // the owning bridge decides its own lifecycle
    },
  };
}
