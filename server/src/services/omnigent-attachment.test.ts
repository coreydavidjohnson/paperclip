import { describe, expect, it } from 'vitest';
import { validOmnigentReceipt } from './omnigent-attachment.js';
const run={id:'run',companyId:'company',agentId:'agent'};
const receipt={version:1,runId:'run',companyId:'company',agentId:'agent',omnigentSessionId:'session',state:'intent'};
describe('same-run attachment evidence',()=>{
 it('accepts durable intent, accepted and observed receipts only for exact owner',()=>{
  for(const state of ['intent','accepted','observed'])expect(validOmnigentReceipt(run,{...receipt,state})).toBe(true);
  for(const patch of [{runId:'other'},{companyId:'other'},{agentId:'other'},{version:2},{omnigentSessionId:''},{state:'replay'}])expect(validOmnigentReceipt(run,{...receipt,...patch})).toBe(false);
  expect(validOmnigentReceipt(run,null)).toBe(false);
 });
});
