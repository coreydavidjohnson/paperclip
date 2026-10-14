import type { Db } from "@paperclipai/db";
import { createLiveEventTransport } from "./live-events-transport.js";
import { EventEmitter } from "node:events";
import type { LiveEvent, LiveEventType } from "@paperclipai/shared";

type LiveEventPayload = Record<string, unknown>;
type LiveEventListener = (event: LiveEvent) => void;

const emitter = new EventEmitter();
emitter.setMaxListeners(0);
const uiEmitter = new EventEmitter();
uiEmitter.setMaxListeners(0);
const transportState = Symbol("transport-state");
let transport: ReturnType<typeof createLiveEventTransport> | undefined;
let transportReady = true;

const allCompanyEvents = Symbol("all-company-live-events");

let nextEventId = 0;

function toLiveEvent(input: {
  companyId: string;
  type: LiveEventType;
  payload?: LiveEventPayload;
}): LiveEvent {
  nextEventId += 1;
  return {
    id: nextEventId,
    companyId: input.companyId,
    type: input.type,
    createdAt: new Date().toISOString(),
    payload: input.payload ?? {},
  };
}

export function publishLiveEvent(input: {
  companyId: string;
  type: LiveEventType;
  payload?: LiveEventPayload;
}) {
  const event = toLiveEvent(input);
  emitter.emit(input.companyId, event);
  emitter.emit(allCompanyEvents, event);
  if (transport) transport.publish(event);
  else uiEmitter.emit(input.companyId, event);
  return event;
}

export function publishGlobalLiveEvent(input: {
  type: LiveEventType;
  payload?: LiveEventPayload;
}) {
  const event = toLiveEvent({ companyId: "*", type: input.type, payload: input.payload });
  emitter.emit("*", event);
  if (transport) transport.publish(event);
  else uiEmitter.emit("*", event);
  return event;
}

export function subscribeCompanyLiveEvents(companyId: string, listener: LiveEventListener) {
  emitter.on(companyId, listener);
  return () => emitter.off(companyId, listener);
}

export function subscribeGlobalLiveEvents(listener: LiveEventListener) {
  emitter.on("*", listener);
  return () => emitter.off("*", listener);
}

/**
 * Internal process-wide observation of company-scoped events. This is kept
 * distinct from the public/global `*` stream so company subscriptions and
 * global instance events retain their existing routing semantics.
 */
export function subscribeAllCompanyLiveEvents(listener: LiveEventListener) {
  emitter.on(allCompanyEvents, listener);
  return () => emitter.off(allCompanyEvents, listener);
}


/** Public/UI subscriptions are separate from origin-only business observers. */
export function subscribeCompanyUiLiveEvents(companyId: string, listener: LiveEventListener) {
  uiEmitter.on(companyId, listener);
  return () => uiEmitter.off(companyId, listener);
}

export function subscribeGlobalUiLiveEvents(listener: LiveEventListener) {
  uiEmitter.on("*", listener);
  return () => uiEmitter.off("*", listener);
}

export function isLiveEventTransportReady() { return transportReady; }

export function subscribeLiveEventTransportState(listener: (ready: boolean) => void) {
  uiEmitter.on(transportState, listener);
  return () => uiEmitter.off(transportState, listener);
}

/** Start before accepting traffic; caller owns stop before closing DB pools. */
export function startLiveEventTransport(db: Db) {
  if (transport) throw new Error("live_event_transport_already_started");
  transport = createLiveEventTransport(db, event => {
    // Numeric IDs are delivery-local, monotonic hints, never replay cursors.
    const delivered = { ...event, id: ++nextEventId };
    uiEmitter.emit(event.companyId, delivered);
  }, ready => {
    if (ready === transportReady) return;
    transportReady = ready;
    uiEmitter.emit(transportState, ready);
  });
  const owned = transport;
  return {
    isReady: isLiveEventTransportReady,
    async stop() {
      await owned.stop();
      if (transport === owned) transport = undefined;
      // Remain fail closed after stop; a new start is needed to serve traffic.
    },
  };
}
