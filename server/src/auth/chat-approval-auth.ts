import { createHmac, randomBytes } from "node:crypto";
import type { Request, RequestHandler } from "express";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { authAccounts, authSessions, authUsers, authVerifications, type Db } from "@paperclipai/db";
import { createBetterAuthHandler, resolveBetterAuthSession, type BetterAuthSessionResult } from "./better-auth.js";
import { readChatApprovalConfig, type ChatApprovalConfig } from "../services/chat-approval-proof.js";

const basePath = "/api/chat-approval-auth";
// Separate cookie and signing domain. Normal board and agent authentication stays unchanged.
export type ChatApprovalAuth = {
  handler: RequestHandler;
  resolveSession: (req: Request) => Promise<BetterAuthSessionResult | null>;
};
export function createChatApprovalAuth(db: Db, config: ChatApprovalConfig): ChatApprovalAuth {
  const auth = betterAuth({
    baseURL: config.origin,
    basePath,
    secret: createHmac("sha256", config.key).update("chat-approval-login-v1").digest("hex"),
    trustedOrigins: [config.origin],
    database: drizzleAdapter(db, { provider: "pg", schema: {
      user: authUsers, session: authSessions, account: authAccounts, verification: authVerifications,
    } }),
    emailAndPassword: { enabled: true, requireEmailVerification: false },
    advanced: { cookiePrefix: "paperclip-chat-approval", useSecureCookies: true },
    rateLimit: { enabled: true },
    session: { expiresIn: 3600 },
  });
  const nativeHandler = createBetterAuthHandler(auth);
  const activeConfig = () => {
    const active = readChatApprovalConfig();
    return active?.origin === config.origin && active.key === config.key ? active : null;
  };
  const handler: RequestHandler = (req, res, next) => {
    const active = activeConfig();
    if (!active) {
      res.status(404).end(); return;
    }
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" });
    if (req.headers.authorization || req.headers["x-paperclip-run-id"]) {
      res.status(403).json({ error: "Agent and run credentials cannot use the human sign-in path" }); return;
    }
    if (req.method === "GET" && req.path === `${basePath}/login`) {
      const nonce = randomBytes(18).toString("base64");
      res.set("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`);
      res.type("html").send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Test approval sign-in</title><main style="max-width:32rem;margin:2rem auto;padding:1rem;font:1rem sans-serif">
<h1>Test approval sign-in</h1><p>Use a password that you enter yourself. Do not give it to an agent. This sign-in does not approve a card or give access to a task.</p>
<form id="login"><p><label>Email <input name="email" type="email" required autocomplete="username"></label></p><p><label>Password <input name="password" type="password" required minlength="8" autocomplete="current-password"></label></p><button value="sign-in">Sign in</button><button value="sign-up">Create account</button></form><p id="result" role="status"></p>
<p>Create account makes a new account only. It does not prove email ownership. Home Lab must bind the correct account to the one test before it can answer. Account creation is off when a card is enrolled.</p>
<script nonce="${nonce}">document.getElementById('login').addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget;const result=document.getElementById('result');const data=new FormData(form);const action=e.submitter?.value;if(!['sign-in','sign-up'].includes(action))return;result.textContent='Please wait.';try{const response=await fetch('${basePath}/'+action+'/email',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:data.get('email'),password:data.get('password'),...(action==='sign-up'?{name:'Approval test user'}:{})})});const body=await response.json();form.elements.password.value='';result.textContent=response.ok?'Signed in. Return to chat and open the test link. Account: '+body.user.id:(body.message||body.error||'Sign-in failed.');}catch{result.textContent='Sign-in failed. Try again after you check your connection.';}});</script></main></html>`);
      return;
    }
    const allowed = req.method === "GET" && req.path === `${basePath}/get-session`
      || req.method === "POST" && ["/sign-in/email", "/sign-out", "/sign-up/email"].some(path => req.path === basePath + path);
    if (!allowed) { res.status(404).end(); return; }
    if (req.method === "POST" && req.get("origin") !== config.origin) {
      res.status(403).json({ error: "The human sign-in origin is required" }); return;
    }
    // New accounts have no grants. Never permit registration while a card can be answered.
    if (req.path === `${basePath}/sign-up/email` && active.enrollments.length) {
      res.status(403).json({ error: "Account creation is closed for this test" }); return;
    }
    nativeHandler(req, res, next);
  };
  return { handler, resolveSession: (req: Request) => activeConfig() ? resolveBetterAuthSession(auth, req) : Promise.resolve(null) };
}
