/**
 * Encode-path statistics (direct vs JSON) accumulated per event name across the
 * process. `createStats()` returns a small counter object; one instance lives
 * in `transport.ts` and is surfaced via `getEncodeStats()` / `server.metrics()`.
 *
 * `bump` is O(1) on the hot path: each (event, path) pair owns a tiny mutable
 * counter box that is allocated once (lazily), so a bump is a single number
 * increment — no Map.get + Map.set churn per encode.
 */
export interface EncodeStats {
  bump(name: string, path: "direct" | "json"): void;
  get(): { direct: Record<string, number>; json: Record<string, number> };
}

/** Mutable counter box — allocated once per (event, path), incremented in place. */
interface Counter {
  n: number;
}

function toObj(m: Map<string, Counter>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, c] of m) out[name] = c.n;
  return out;
}

export function createStats(): EncodeStats {
  const direct = new Map<string, Counter>();
  const json = new Map<string, Counter>();

  return {
    bump(name, path) {
      const m = path === "direct" ? direct : json;
      let c = m.get(name);
      if (!c) {
        c = { n: 0 };
        m.set(name, c);
      }
      c.n++;
    },
    get() {
      return { direct: toObj(direct), json: toObj(json) };
    },
  };
}
