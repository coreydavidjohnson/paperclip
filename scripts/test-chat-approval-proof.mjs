import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { ApprovalProofError, readChatApprovalConfig, requireHuman, requireEnrollment, assertSimpleTestCard, present, verify, parseAnswer, renderPrompt } from '../server/src/services/chat-approval-proof.ts';
const e = { companyId:'company', issueId:'issue', interactionId:'card', userId:'human', chatId:'chief-chat', submittingAgentId:'chief', revision:'test-1', action:'Run synthetic no-op', target:'Disposable fixture', scope:'Synthetic data only', undo:'Delete the fixture', effect:'synthetic_test_only', loginAccountId:'account', designationId:'designation', designationHash:'a'.repeat(64), expiresAt:'2099-01-01T00:00:00.000Z' };
const config = { origin:'https://approval.example.test', key:randomBytes(32).toString('hex'), enrollments:[e] };
const human = { type:'board', source:'session', chatApprovalSession:true, userId:'human', chatApprovalAccountId:'account', sessionId:'human-login' };
const snapshot = { question:'Approve this synthetic test?', target:'fixture-v1' };
const card = { id:'card', companyId:'company', issueId:'issue', kind:'request_confirmation', createdByAgentId:'chief', payload:{version:1,prompt:snapshot.question} };
test('off by default and refuses malformed or broad configuration', () => {
  assert.equal(readChatApprovalConfig({}), null);
  const env = { PAPERCLIP_CHAT_APPROVAL_ENABLED:'1', PAPERCLIP_CHAT_APPROVAL_ORIGIN:config.origin, PAPERCLIP_CHAT_APPROVAL_HMAC_KEY:config.key, PAPERCLIP_CHAT_APPROVAL_ENROLLMENTS:JSON.stringify([e]) };
  assert.deepEqual(readChatApprovalConfig(env), config);
  for (const override of [ {PAPERCLIP_CHAT_APPROVAL_ORIGIN:'http://approval.example.test'}, {PAPERCLIP_CHAT_APPROVAL_ORIGIN:config.origin+'/'}, {PAPERCLIP_CHAT_APPROVAL_HMAC_KEY:'short'}, {PAPERCLIP_CHAT_APPROVAL_ENROLLMENTS:JSON.stringify([{...e,effect:'production'}])}, {PAPERCLIP_CHAT_APPROVAL_ENROLLMENTS:JSON.stringify([e,e])} ]) assert.throws(() => readChatApprovalConfig({...env,...override}));
});
for (const source of ['local_implicit','board_key','agent_key','agent_jwt','mcp_oauth','cloud_tenant','none']) test(`rejects ${source} even with a copied human id`, () => assert.throws(() => requireHuman({...human,source})));
test('rejects ordinary login sessions without the dedicated credential boundary', () => {
  for (const chatApprovalSession of [undefined, false]) assert.throws(() => requireHuman({...human,chatApprovalSession}), ApprovalProofError);
});
test('rejects owner tokens, session editors, actor/run claims and another login', () => {
  for (const actor of [{...human,type:'agent'}, {...human,userId:'editor'}, {...human,sessionId:null}, {...human,agentId:'chief'}, {...human,runId:'run'}]) assert.throws(() => requireEnrollment(config,'issue','card',actor));
  const {token} = present(config,e,human,snapshot,1000);
  assert.throws(() => verify(config,e,{...human,sessionId:'other-login'},token,config.origin,1001));
});
test('binds exact human, chat, card, scope, target display, origin and expiry', () => {
  const {token,presentation} = present(config,e,human,snapshot,1000);
  assert.deepEqual(verify(config,e,human,token,config.origin,1001),presentation);
  for (const other of [{...e,chatId:'foreign'}, {...e,interactionId:'foreign'}, {...e,scope:'wider'}, {...e,revision:'revoked'}]) assert.throws(() => verify(config,other,human,token,config.origin,1001));
  for (const origin of [undefined,'null','https://evil.example.test']) assert.throws(() => verify(config,e,human,token,origin,1001));
  assert.throws(() => verify(config,e,human,token,config.origin,601000));
  assert.throws(() => verify(config,e,human,token,config.origin,999));
  assert.throws(() => verify(config,e,human,token+'x',config.origin,1001));
  // Equal character counts must not let a multibyte signature reach timingSafeEqual.
  assert.throws(() => verify(config,e,human,token.split('.')[0]+'.'+'é'.repeat(43),config.origin,1001), ApprovalProofError);
  assert.throws(() => verify({...config,key:randomBytes(32).toString('hex')},e,human,token,config.origin,1001));
});
test('governed, mixed, foreign and unknown cards are never enabled by a test label', () => {
  assert.doesNotThrow(() => assertSimpleTestCard(e,card));
  assert.doesNotThrow(() => assertSimpleTestCard(e,{...card,payload:{...card.payload,allowDeclineReason:true,detailsMarkdown:'Synthetic data only',acceptLabel:null}}));
  for (const extra of ['toolAction','secretProposal','connectionAuthorization','target','unknown']) assert.throws(() => assertSimpleTestCard(e,{...card,payload:{...card.payload,[extra]:{}}}));
  for (const override of [{companyId:'foreign'},{createdByAgentId:'foreign'},{kind:'ask_user_questions'}]) assert.throws(() => assertSimpleTestCard(e,{...card,...override}));
  for (const label of [{acceptLabel:'Delete all data'}, {rejectLabel:'Approve'}]) assert.throws(() => assertSimpleTestCard(e,{...card,payload:{...card.payload,...label}}));
});
test('accepts explicit controls or exact typed words, never a model interpretation', () => {
  assert.deepEqual(parseAnswer('accept',''),{decision:'accept',exactAnswer:'Approve'});
  assert.deepEqual(parseAnswer('','  ApPrOvE  '),{decision:'accept',exactAnswer:'  ApPrOvE  '});
  assert.deepEqual(parseAnswer('reject','deny'),{decision:'reject',exactAnswer:'deny'});
  for (const pair of [['',''],['accept','deny'],['accept','yes'],['','yes'],['unknown',''],[[], 'approve'],['accept','a'.repeat(257)]]) assert.throws(() => parseAnswer(...pair));
});
test('renders complete question and scope, escapes hostile content and provides no default answer', () => {
  const html=renderPrompt({...e,target:'<script>steal()</script>'},'<img src=x onerror=steal()>','All help text','signed-proof','/api/fixture');
  assert.ok(html.includes('&lt;script&gt;steal()&lt;/script&gt;'));
  assert.ok(!html.includes('<script>') && !html.includes('<img'));
  for (const value of ['All help text',e.scope,e.action,e.undo,'signed-proof']) assert.ok(html.includes(value));
  assert.ok(!html.includes('checked') && !html.includes('autofocus'));
  // Browsers use the first submit control for Enter. An empty field must not approve.
  const implicitChoice = html.match(/<button name="choice" value="([^"]*)"/)[1];
  assert.throws(() => parseAnswer(implicitChoice,''), ApprovalProofError);
});
