import { expect, it } from 'vitest';
import { decideExternalRunLiveness } from './external-run-liveness.js';
it('requires two stored gone confirmations', () => {
 const now=new Date(); const run={deadlineAt:null,unknownSince:null,livenessProbe:null};
 const d=decideExternalRunLiveness(run,{state:'gone',reason:'missing'},now);
 expect(d.end).toBeUndefined();
 expect(decideExternalRunLiveness({...run,livenessProbe:d.probe},{state:'gone',reason:'missing'},new Date(now.getTime()+120000)).end).toBe('external_session_gone');
});

it("settled results permit at most three harvest attempts", () => {
 const now=new Date();let run={deadlineAt:null,unknownSince:null,livenessProbe:null as Record<string,unknown>|null};
 for(let i=1;i<=3;i++){const d=decideExternalRunLiveness(run,{state:"settled"},now);expect(d.harvest).toBe(true);expect(d.probe.harvestAttempts).toBe(i);run={...run,livenessProbe:d.probe};}
 expect(decideExternalRunLiveness(run,{state:"settled"},now).end).toBe("external_result_unavailable");
});
it("active evidence clears an outage clock and never advances progress", () => {
 const d=decideExternalRunLiveness({deadlineAt:null,unknownSince:new Date(0),livenessProbe:{state:"unknown"}},{state:"active"},new Date());
 expect(d.unknownSince).toBeNull();expect(d.alive).toBe(true);expect(d.end).toBeUndefined();
});
it("a first unknown stays pending but a two-hour outage becomes reconcile-only", () => {
 const now=new Date(); const run={deadlineAt:null,unknownSince:null,livenessProbe:null};
 const d=decideExternalRunLiveness(run,{state:"unknown",reason:"outage"},now);expect(d.end).toBeUndefined();
 expect(decideExternalRunLiveness({...run,unknownSince:d.unknownSince},{state:"unknown",reason:"outage"},new Date(now.getTime()+7200000)).end).toBe("external_liveness_unknown");
});
it("new active evidence interrupts nonconsecutive gone confirmations", () => {
 const now=new Date();const d=decideExternalRunLiveness({deadlineAt:null,unknownSince:null,livenessProbe:{state:"active"}},{state:"gone",reason:"offline"},now);expect(d.end).toBeUndefined();expect(d.probe.firstGoneAt).toBe(now.toISOString());
});
