/** Run only with the release's database/configuration and external-adapter set. */
import { parseArgs } from 'node:util';
import { createDb } from '@paperclipai/db';
import { waitForExternalAdapters } from './adapters/registry.js';
import { heartbeatService } from './services/heartbeat.js';

const { values } = parseArgs({ options: {
 company: { type: 'string' }, after: { type: 'string' }, apply: { type: 'boolean', default: false },
} });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!values.company || !uuid.test(values.company) || (values.after && !uuid.test(values.after))) {
 throw new Error('Usage: sweep-parked-external-wakes --company <uuid> [--after <wake-uuid>] [--apply]');
}
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must select the release database');
await waitForExternalAdapters();
const db = createDb(process.env.DATABASE_URL);
try {
 const heartbeat = heartbeatService(db);
 // One bounded page, not a daemon. Existing server outbox delivery owns admission.
 const report = await heartbeat.sweepParkedExternalWakes({ companyId: values.company, afterWakeId: values.after, apply: values.apply });
 console.log(JSON.stringify(report, null, 2));
} finally { await db.$client.end({ timeout: 0 }); }
