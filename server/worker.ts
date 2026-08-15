// The Worker: static assets, Google sign-in, house assignment, and the one
// endpoint that matters, which replays a submitted run and decides its time.
//
// The client never reports a score. It reports what keys were pressed and when.

import { houseSlots, type Pin } from '../sim/puzzle.js';
import { buildBoard } from './board.js';
import { scoreRun, type Submission } from './score.js';

export type Env = {
  ASSETS: { fetch(req: Request): Promise<Response> };
  DB: D1Database;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  SESSION_SECRET?: string;
};

const SESSION_COOKIE = 'doordle_session';
const STATE_COOKIE = 'doordle_oauth';
const SESSION_DAYS = 30;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

// ------------------------------------------------------------------ sessions

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/[+/=]/g, (c) =>
    ({ '+': '-', '/': '_', '=': '' })[c] as string,
  );
}

/** Constant time, so a wrong signature cannot be found one character at a time. */
function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function signSession(secret: string, userId: string): Promise<string> {
  const expires = Date.now() + SESSION_DAYS * 86_400_000;
  const body = `${userId}.${expires}`;
  return `${body}.${await hmac(secret, body)}`;
}

async function readSession(secret: string, token: string | null): Promise<string | null> {
  if (!token) return null;
  const cut = token.lastIndexOf('.');
  if (cut < 0) return null;
  const body = token.slice(0, cut);
  if (!sameString(token.slice(cut + 1), await hmac(secret, body))) return null;
  const [userId, expires] = [body.slice(0, body.lastIndexOf('.')), body.slice(body.lastIndexOf('.') + 1)];
  if (!userId || Number(expires) < Date.now()) return null;
  return userId;
}

function cookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

const setCookie = (name: string, value: string, maxAge: number) =>
  `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

// ------------------------------------------------------------------- houses

/**
 * Give this account a house, permanently. Claims the lowest free slot, which
 * keeps assignment deterministic and packs the city from the centre outwards.
 * The UNIQUE constraints, not this code, are what make it safe under a race.
 */
async function claimHouse(db: D1Database, userId: string): Promise<number> {
  const existing = await db
    .prepare('SELECT slot FROM house_claims WHERE user_id = ?')
    .bind(userId)
    .first<{ slot: number }>();
  if (existing) return existing.slot;

  const slots = houseSlots().length;
  for (let attempt = 0; attempt < 5; attempt++) {
    const next = await db
      .prepare('SELECT COALESCE(MAX(slot), -1) + 1 AS slot FROM house_claims')
      .first<{ slot: number }>();
    const slot = next?.slot ?? 0;
    if (slot >= slots) throw new Error('house pool exhausted');
    try {
      await db
        .prepare('INSERT INTO house_claims (slot, user_id, claimed_at) VALUES (?, ?, ?)')
        .bind(slot, userId, new Date().toISOString())
        .run();
      return slot;
    } catch {
      // Someone took that slot between the read and the write. Look again.
    }
  }
  throw new Error('could not claim a house');
}

async function homeOf(db: D1Database, userId: string): Promise<Pin> {
  const slot = await claimHouse(db, userId);
  return houseSlots()[slot];
}

// --------------------------------------------------------------------- auth

function oauthConfigured(env: Env): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.SESSION_SECRET);
}

async function startLogin(req: Request, env: Env): Promise<Response> {
  const state = crypto.randomUUID();
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', env.GOOGLE_CLIENT_ID!);
  url.searchParams.set('redirect_uri', new URL('/auth/callback', req.url).toString());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email');
  url.searchParams.set('state', state);
  return new Response(null, {
    status: 302,
    headers: { location: url.toString(), 'set-cookie': setCookie(STATE_COOKIE, state, 600) },
  });
}

async function finishLogin(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  // Without this check a third party could walk someone through a login that
  // silently lands them in an account they do not own.
  if (!code || !state || !sameString(state, cookie(req, STATE_COOKIE) ?? '')) {
    return json({ error: 'bad oauth state' }, 400);
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: new URL('/auth/callback', req.url).toString(),
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) return json({ error: 'token exchange failed' }, 502);

  const { id_token } = (await res.json()) as { id_token?: string };
  if (!id_token) return json({ error: 'no id_token' }, 502);

  // The token came straight from Google over TLS in exchange for our client
  // secret, so its payload is read rather than re-verified. If this ever starts
  // arriving from anywhere else, verify the signature against Google's JWKS.
  const claims = JSON.parse(atob(id_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  const userId = String(claims.sub);
  const email = String(claims.email ?? '');
  if (!userId) return json({ error: 'no subject' }, 502);

  await env.DB.prepare(
    'INSERT INTO users (id, email, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET email = excluded.email',
  )
    .bind(userId, email, new Date().toISOString())
    .run();
  await claimHouse(env.DB, userId);

  return new Response(null, {
    status: 302,
    headers: {
      location: '/',
      'set-cookie': setCookie(SESSION_COOKIE, await signSession(env.SESSION_SECRET!, userId), SESSION_DAYS * 86_400),
    },
  });
}

// ------------------------------------------------------------------ handlers

async function currentUser(req: Request, env: Env): Promise<string | null> {
  if (!env.SESSION_SECRET) return null;
  return readSession(env.SESSION_SECRET, cookie(req, SESSION_COOKIE));
}

async function handleMe(req: Request, env: Env): Promise<Response> {
  const userId = await currentUser(req, env);
  if (!userId) return json({ signedIn: false, oauth: oauthConfigured(env) });
  const user = await env.DB.prepare('SELECT email FROM users WHERE id = ?')
    .bind(userId)
    .first<{ email: string }>();
  return json({ signedIn: true, email: user?.email ?? null, home: await homeOf(env.DB, userId) });
}

async function handleRun(req: Request, env: Env): Promise<Response> {
  const userId = await currentUser(req, env);
  // Guests play the full game but never appear on a board (SPEC.md §8), so a
  // missing session is an expected outcome here, not an error to hide.
  if (!userId) return json({ error: 'sign in to record a run' }, 401);

  let sub: Submission;
  try {
    sub = (await req.json()) as Submission;
  } catch {
    return json({ error: 'body must be json' }, 400);
  }

  const verdict = scoreRun(sub, await homeOf(env.DB, userId));
  if (!verdict.ok) return json({ error: verdict.reason }, 422);

  try {
    await env.DB.prepare(
      'INSERT INTO runs (user_id, date, finish_tick, state_hash, timeline, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(
        userId,
        sub.date,
        verdict.finishTick,
        verdict.stateHash,
        JSON.stringify(sub.inputEvents),
        new Date().toISOString(),
      )
      .run();
  } catch {
    // The unique index did its job: this account already has a run today.
    return json({ error: 'already played today' }, 409);
  }

  return json({ finishTick: verdict.finishTick });
}

/**
 * The board is locked until you have submitted a run for that day (SPEC.md §9),
 * so that nobody can scout other people's times before playing. Owning a run on
 * the date IS the key: no run, no board.
 */
async function handleBoard(req: Request, env: Env): Promise<Response> {
  const userId = await currentUser(req, env);
  if (!userId) return json({ error: 'sign in to see the board' }, 401);

  const date = new URL(req.url).searchParams.get('date') ?? '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: 'bad date' }, 400);

  const mine = await env.DB.prepare('SELECT finish_tick FROM runs WHERE user_id = ? AND date = ?')
    .bind(userId, date)
    .first<{ finish_tick: number }>();
  if (!mine) return json({ error: 'play today first' }, 403);

  const utcToday = new Date().toISOString().slice(0, 10);
  return json(await buildBoard(env.DB, userId, date, mine.finish_tick, utcToday));
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(req.url);

    if (pathname === '/api/health') return json({ ok: true, oauth: oauthConfigured(env) });
    if (pathname === '/api/me') return handleMe(req, env);
    if (pathname === '/api/board') return handleBoard(req, env);
    if (pathname === '/api/run') {
      if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
      return handleRun(req, env);
    }
    if (pathname === '/auth/login' || pathname === '/auth/callback') {
      if (!oauthConfigured(env)) return json({ error: 'sign-in is not configured' }, 503);
      return pathname === '/auth/login' ? startLogin(req, env) : finishLogin(req, env);
    }

    return env.ASSETS.fetch(req);
  },
};
