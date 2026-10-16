import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { badRequest, forbidden, HttpError, unauthorized } from '../errors.js';

const identity = z.string().min(1).max(253).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/);
const object = z.object({ apiVersion: z.string().min(1).max(253).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9_.-]*)?$/), kind: identity, namespace: identity, name: identity, uid: identity }).strict();
export const desktopRecoveryRequest = z.object({
  version: z.literal(1), agent: identity, desktop: identity,
  incidents: z.array(z.object({ id: identity, reason: z.string().min(1).max(2000), time: z.number().finite().positive(), involvedObject: object }).strict()).max(100),
  ready: z.object({ recoveryId: identity,
    batch: z.object({ namespace: identity, name: identity, uid: identity, generation: z.number().int().positive(), observedGeneration: z.number().int().positive() }).strict(),
    podUid: identity, observedAt: z.number().finite().positive().optional(),
  }).strict().nullish(),
}).strict().superRefine((request, context) => {
  if (new Set(request.incidents.map(incident => incident.id)).size !== request.incidents.length)
    context.addIssue({ code: 'custom', message: 'Duplicate incident identity' });
  if (request.ready && (request.ready.batch.name !== request.desktop || request.ready.batch.generation !== request.ready.batch.observedGeneration))
    context.addIssue({ code: 'custom', message: 'Ready requires the current observed generation of this desktop' });
});
export type DesktopRecoveryRequest = z.infer<typeof desktopRecoveryRequest>;
export const desktopRecoveryTarget = z.object({ companyId: z.string().uuid(), agentId: z.string().uuid(), desktop: identity, namespace: identity, incidentIssueId: z.string().uuid(), restoreOnlyIssueIds: z.array(z.string().uuid()).default([]) }).strict();
export type DesktopRecoveryTarget = z.infer<typeof desktopRecoveryTarget>;
export type DesktopRecoveryOptions = {
  token?: string;
  targets: Record<string, DesktopRecoveryTarget>;
  resumeEnabled?: boolean;
  handle: (request: DesktopRecoveryRequest, target: DesktopRecoveryTarget, resumeEnabled: boolean) => Promise<unknown>;
};

/** This credential is accepted here only. It never becomes a board or agent actor. */
export function desktopRecoveryRoutes(options: DesktopRecoveryOptions) {
  const router = Router();
  router.post('/api/internal/desktop-recovery', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const configured = options.token;
    if (!configured || configured.length < 32) throw new HttpError(503, 'Desktop recovery service is not configured');
    const provided = req.get('X-Desktop-Recovery-Token');
    if (req.get('Authorization') || req.get('Cookie') || req.get('X-Paperclip-Run-Id') || !provided)
      throw unauthorized('Dedicated desktop recovery authentication required');
    const actual = Buffer.from(provided);
    const expected = Buffer.from(configured);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw unauthorized();
    const parsed = desktopRecoveryRequest.safeParse(req.body);
    if (!parsed.success) throw badRequest('Invalid desktop recovery request');
    const request = parsed.data;
    if (options.resumeEnabled && request.ready &&
        (request.ready.observedAt === undefined || request.ready.observedAt > Date.now()/1000 + 5 || request.ready.observedAt < Date.now()/1000 - 60))
      throw badRequest('Resume requires a Ready observation from the last 60 seconds');
    const binding = Object.hasOwn(options.targets, request.agent) ? options.targets[request.agent] : null;
    if (!binding || binding.desktop !== request.desktop ||
      (request.ready && request.ready.batch.namespace !== binding.namespace) ||
      request.incidents.some(incident => incident.involvedObject.namespace !== binding.namespace ||
        incident.involvedObject.name !== binding.desktop || incident.involvedObject.kind !== 'BatchSandbox'))
      throw forbidden('Desktop is not registered for this recovery service');
    res.json(await options.handle(request, binding, options.resumeEnabled === true));
  });
  return router;
}

/** Prevent dedicated authentication from falling through to local_trusted. */
export const desktopRecoveryCredentialBoundary: import('express').RequestHandler = (req, _res, next) => {
  if (req.get('X-Desktop-Recovery-Token') !== undefined &&
      !(req.method === 'POST' && req.path === '/api/internal/desktop-recovery')) {
    next(unauthorized('Desktop recovery authentication is restricted to its endpoint'));
    return;
  }
  next();
};

/** Credentials/targets remain a separate approved Secret change. */
export function desktopRecoveryConfig(env: NodeJS.ProcessEnv) {
  const targets = z.record(identity, desktopRecoveryTarget).parse(JSON.parse(env.PAPERCLIP_DESKTOP_RECOVERY_TARGETS ?? '{}'));
  return { token: env.PAPERCLIP_DESKTOP_RECOVERY_TOKEN, targets,
    resumeEnabled: env.PAPERCLIP_DESKTOP_RECOVERY_RESUME_ENABLED === 'true' };
}
