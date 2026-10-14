import { randomUUID } from "node:crypto";
import { postgres, type Db } from "@paperclipai/db";
import { LIVE_EVENT_TYPES, type LiveEvent } from "@paperclipai/shared";

const CHANNEL = "paperclip_ui_events_v1";
const MAX_BYTES = 7500; // PostgreSQL NOTIFY is strictly less than 8000 bytes.
const MAX_PENDING = 128;
const MAX_ORIGINS = 1024;

/** Ephemeral UI hints only: never replay uncertain writes or run business observers. */
export function createLiveEventTransport(
  db: Db, receive: (event: LiveEvent) => void, setReady: (ready: boolean) => void,
) {
  const origin = randomUUID();
  let sequence = 0;
  let stopped = false;
  let ready = false;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let client: ReturnType<typeof postgres> | undefined;
  let draining = false;
  const pending: string[] = [];
  const seen = new Map<string, number>();

  function readiness(value: boolean) { ready = value; setReady(value); }

  function fail(epoch: number) {
    if (epoch !== generation || stopped) return;
    generation += 1;
    readiness(false);
    pending.length = 0; // A lost response is not evidence that NOTIFY did not commit.
    seen.clear();
    draining = false;
    clearTimeout(timer);
    const old = client;
    client = undefined;
    void old?.end({ timeout: 0 }).catch(() => {});
    timer = setTimeout(connect, 1000);
  }

  function notification(raw: string, epoch: number) {
    if (epoch !== generation || !ready) return;
    if (Buffer.byteLength(raw) > MAX_BYTES) { fail(epoch); return; }
    try {
      const data = JSON.parse(raw);
      const event = data.event;
      if (typeof data.origin !== "string" || !/^[0-9a-f-]{36}$/.test(data.origin) ||
          !Number.isSafeInteger(data.sequence) || data.sequence < 1 ||
          !event || typeof event.companyId !== "string" || !event.companyId ||
          !LIVE_EVENT_TYPES.includes(event.type) || typeof event.createdAt !== "string" ||
          !Number.isSafeInteger(event.id) || event.id < 1 ||
          !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
        fail(epoch);
        return;
      }
      if (data.sequence <= (seen.get(data.origin) ?? 0)) return;
      if (!seen.has(data.origin) && seen.size >= MAX_ORIGINS) {
        fail(epoch); // Bounded dedupe, resync rather than silently evicting cursors.
        return;
      }
      seen.set(data.origin, data.sequence);
      receive(event);
    } catch { fail(epoch); }
  }

  // A socket blackhole must not leave readiness green indefinitely. Ending the
  // generation bounds stalled queries; no query is replayed.
  async function bounded<T>(operation: PromiseLike<T>, epoch: number): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve(operation),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            fail(epoch);
            reject(new Error("live_event_transport_timeout"));
          }, 3000);
        }),
      ]);
    } finally { clearTimeout(timeout); }
  }

  async function probe(epoch: number) {
    const sql = client;
    if (!sql || stopped || epoch !== generation) return;
    try {
      await bounded(sql.unsafe(`LISTEN ${CHANNEL}`), epoch);
      if (stopped || epoch !== generation) return;
      readiness(true);
      timer = setTimeout(() => { void probe(epoch); }, 1000);
    } catch { fail(epoch); }
  }

  function connect() {
    if (stopped) return;
    const epoch = ++generation;
    // Reuse resolved credentials/TLS/multi-host configuration, not the DB pool.
    const options = {
      ...db.$client.options,
      max: 1, prepare: false, idle_timeout: 0, max_lifetime: 0,
      connect_timeout: 2, fetch_types: false,
      connection: { ...db.$client.options.connection, application_name: "paperclip-live-events", statement_timeout: 2000 },
      onnotify: (channel: string, raw: string) => { if (channel === CHANNEL) notification(raw, epoch); },
      onclose: () => fail(epoch),
    };
    // postgres.js supports onnotify and parsed multi-host arrays at runtime;
    // its public Options type omits both (3.4.x).
    client = postgres(options as unknown as Exclude<Parameters<typeof postgres>[1], undefined>);
    void probe(epoch);
  }

  async function drain(epoch: number) {
    if (draining) return;
    draining = true;
    try {
      while (pending.length && ready && !stopped && epoch === generation) {
        const raw = pending.shift()!;
        await bounded(client!.notify(CHANNEL, raw), epoch);
      }
    } catch { fail(epoch); }
    finally { if (epoch === generation) draining = false; }
  }

  readiness(false);
  connect();
  return {
    publish(event: LiveEvent) {
      if (!ready || stopped) return;
      try {
        const raw = JSON.stringify({ origin, sequence: ++sequence, event });
        if (Buffer.byteLength(raw) > MAX_BYTES || pending.length >= MAX_PENDING) {
          // Reset envelopes force *both* pods to resync, never truncate chunks.
          pending.length = 0;
          pending.push(JSON.stringify({ origin, sequence: ++sequence, reset: true }));
        } else { pending.push(raw); }
      } catch {
        pending.length = 0;
        pending.push(JSON.stringify({ origin, sequence: ++sequence, reset: true }));
      }
      void drain(generation);
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      generation += 1;
      readiness(false);
      clearTimeout(timer);
      pending.length = 0;
      const old = client;
      client = undefined;
      await old?.end({ timeout: 0 });
    },
  };
}
