/**
 * Loopback HTTP echo benchmark: Nova binary vs Bun JSON, identical payload and
 * full client/server decode. Interleaved fixed-op trials; median/min/CV output.
 */
import { defaultBindings } from "../public/bindings";
import { createNativeMessageCodec, createServiceHandler } from "../public/messaging-server";

const codec = createNativeMessageCodec(defaultBindings);
const novaHandler = createServiceHandler({ codec, onMessage: (message) => message });
const jsonHandler = async (req: Request): Promise<Response> => Response.json(await req.json());
const server = Bun.serve({
  port: 0,
  fetch: (req) => new URL(req.url).pathname === "/nova" ? novaHandler(req) : jsonHandler(req),
});
const base = `http://localhost:${server.port}`;
const quote = { symbol: "AAPL", bid: 180.1, ask: 180.2, bidSize: 100, askSize: 200, ts: 123456789 };
const complex = {
  id: "batch-1",
  names: Array.from({ length: 200 }, (_, i) => `symbol-${i}`),
  prices: Array.from({ length: 200 }, (_, i) => i + 0.25),
  counts: Array.from({ length: 200 }, (_, i) => i * 1000),
  flags: Array.from({ length: 200 }, (_, i) => i % 2 === 0),
  tags: Array.from({ length: 200 }, (_, i) => i % 2 === 0 ? "hot" : "new"),
  active: true,
  total: 12345.67,
  ts: 123456789,
};

type Kind = "nova" | "json";
type Event = "quote" | "complex";

async function post(kind: Kind, event: Event, payload: unknown): Promise<void> {
  const isNova = kind === "nova";
  const response = await fetch(`${base}/${kind}`, {
    method: "POST",
    headers: { "content-type": isNova ? "application/vnd.ignex.nova" : "application/json" },
    body: isNova ? codec.encode(event, payload as never) as Uint8Array<ArrayBuffer> : JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`${kind} returned ${response.status}`);
  if (isNova) {
    if (codec.decode(new Uint8Array(await response.arrayBuffer())) === null) throw new Error("bad Nova reply");
  } else {
    await response.json();
  }
}

async function measure(kind: Kind, event: Event, payload: unknown, count: number): Promise<number> {
  const start = Bun.nanoseconds();
  for (let i = 0; i < count; i++) await post(kind, event, payload);
  return (Bun.nanoseconds() - start) / count / 1000;
}

const stats = (values: number[]): { median: number; min: number; cv: number } => {
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return { median, min: sorted[0]!, cv: Math.sqrt(variance) / mean * 100 };
};

async function bench(label: string, event: Event, payload: unknown, count: number): Promise<void> {
  for (let i = 0; i < Math.max(50, Math.floor(count / 5)); i++) {
    await post("nova", event, payload);
    await post("json", event, payload);
  }
  const trials = Math.max(3, Number(process.env.TRIALS ?? 9));
  const nova: number[] = [];
  const json: number[] = [];
  for (let round = 0; round < trials; round++) {
    const first: Kind = round % 2 === 0 ? "nova" : "json";
    const second: Kind = first === "nova" ? "json" : "nova";
    (first === "nova" ? nova : json).push(await measure(first, event, payload, count));
    (second === "nova" ? nova : json).push(await measure(second, event, payload, count));
  }
  const n = stats(nova);
  const j = stats(json);
  console.log(`${label} (${trials} interleaved trials × ${count})`);
  console.log(`  Nova median ${n.median.toFixed(1)} us · min ${n.min.toFixed(1)} · CV ${n.cv.toFixed(1)}%`);
  console.log(`  JSON median ${j.median.toFixed(1)} us · min ${j.min.toFixed(1)} · CV ${j.cv.toFixed(1)}%`);
  console.log(`  JSON/Nova latency ratio: ${(j.median / n.median).toFixed(2)}x; throughput ratio: ${(n.median / j.median * 100).toFixed(1)}%`);
}

await bench("small quote echo", "quote", quote, Number(process.env.SMALL_OPS ?? 1000));
await bench("200-item vector echo", "complex", complex, Number(process.env.LARGE_OPS ?? 100));
server.stop(true);
