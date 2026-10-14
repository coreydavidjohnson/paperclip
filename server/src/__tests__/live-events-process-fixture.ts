import { createServer } from "node:http";
import { createDb } from "@paperclipai/db";
import { setupLiveEventsWebSocketServer } from "../realtime/live-events-ws.js";
import { publishLiveEvent, publishGlobalLiveEvent, subscribeAllCompanyLiveEvents, subscribeCompanyLiveEvents, startLiveEventTransport, subscribeLiveEventTransportState } from "../services/live-events.js";

const db = createDb(process.env.LIVE_EVENTS_TEST_DATABASE_URL!);
let business = 0;
let companyObserver = 0;
subscribeAllCompanyLiveEvents(() => { business++; });
subscribeCompanyLiveEvents("a", () => { companyObserver++; });
subscribeLiveEventTransportState(ready => process.send?.({ ready }));
const transport = startLiveEventTransport(db);
const server = createServer((_req, res) => { res.end("fixture"); });
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
