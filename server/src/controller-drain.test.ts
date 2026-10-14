import { expect, it } from 'vitest';
import { beginControllerDrain, controllerDrainRemainingMs, isControllerDraining } from './controller-drain.js';
import { completeControllerTurnsForShutdown } from './shutdown.js';
it('drain is one-way, preserves the first preStop deadline, bounds scheduler DB hangs', async () => {
 expect(isControllerDraining()).toBe(false);
 const deadline=beginControllerDrain(Date.now(),30);
 expect(beginControllerDrain(Date.now(),120000)).toBe(deadline);
 expect(controllerDrainRemainingMs()).toBeLessThanOrEqual(30);
 const started=Date.now();
 const result=await completeControllerTurnsForShutdown({signal:'SIGTERM',
  waitForSchedulerIdle:()=>new Promise(()=>{}), drain:async()=>{}, log:console});
 expect(result).toBe('timed_out');expect(Date.now()-started).toBeLessThan(1000);
 expect(isControllerDraining()).toBe(true);
 expect(controllerDrainRemainingMs()).toBe(0);
});
