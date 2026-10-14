import { createServer } from "node:http";
import express from "express";
import { createDb } from "@paperclipai/db";
import { setupLiveEventsWebSocketServer } from "../realtime/live-events-ws.js";
import { publishLiveEvent, publishGlobalLiveEvent, subscribeAllCompanyLiveEvents, subscribeCompanyLiveEvents, startLiveEventTransport, subscribeLiveEventTransportState, isLiveEventTransportReady } from "../services/live-events.js";

const db = createDb(process.env.LIVE_EVENTS_TEST_DATABASE_URL!);
let business = 0;
let companyObserver = 0;
subscribeAllCompanyLiveEvents(() => { business++; });
subscribeCompanyLiveEvents("a", () => { companyObserver++; });
subscribeLiveEventTransportState(ready => process.send?.({ ready }));
const transport = startLiveEventTransport(db);
const app = express();
if (process.env.LIVE_EVENTS_TEST_INTEGRATED_HEALTH === "1") {
  const { healthRoutes } = await import("../routes/health.js");
  app.use(healthRoutes(db));
} else {
  app.get("/ready", (_req, res) => res.status(isLiveEventTransportReady() ? 200 : 503).end("fixture"));
}
const server = createServer(app);
const wss = setupLiveEventsWebSocketServer(server, db, { deploymentMode: "local_trusted" });
server.listen(0, "127.0.0.1", () => {
  process.send?.({ port: (server.address() as { port: number }).port });
});
process.on("message", async (message: any) => {
  if (message.command === "publish") {
    const event = message.companyId === "*"
      ? publishGlobalLiveEvent({ type: "plugin.ui.updated", payload: message.payload })
      : publishLiveEvent({ companyId: message.companyId, type: "activity.logged", payload: message.payload });
    process.send?.({ request: message.request, event, business, companyObserver });
  } else if (message.command === "burst") {
    for (let i = 0; i < 300; i++) publishLiveEvent({ companyId: "a", type: "activity.logged", payload: { burst: i } });
    process.send?.({ request: message.request, business });
  } else if (message.command === "pressure") {
    for (let i = 0; i < 100; i++) publishLiveEvent({ companyId: "a", type: "activity.logged", payload: { chunk: "x".repeat(6000), pressure: i } });
    process.send?.({ request: message.request, business });
  } else if (message.command === "socket-stats") {
    process.send?.({ request: message.request, buffered: [...wss.clients].map(socket => socket.bufferedAmount), clients: wss.clients.size });
  } else if (message.command === "transport-stop") {
    await transport.stop();
    process.send?.({ request: message.request, ready: isLiveEventTransportReady() });
  } else if (message.command === "stats") {
    process.send?.({ request: message.request, business, companyObserver, ready: transport.isReady() });
  } else if (message.command === "stop") {
    await transport.stop();
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await db.$client.end({ timeout: 0 });
    process.exit(0);
  }
});
