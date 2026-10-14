// lib/guard.js — 3-LAYER SERVER GUARD (anti-flood / anti-script)
//
// Goal: a script (Termux, curl loop, bot farm) must NOT be able to push
// 500 / 1k / 2k requests per minute into the bot and kill the free plan
// (Vercel function invocations + MongoDB Atlas connections/ops).
//
//  LAYER 1 — "Gate"   (RAM only, zero DB, zero network)
//      • oversized body → 413
//      • IP / user already blocked (RAM cache) → 429 instantly
//      • per-IP burst limit per 10 seconds (per warm instance)
//      • invalid / missing Telegram initData → 401 (HMAC check = CPU only),
//        too many bad-auth attempts → IP blocked in RAM
//      The flood is cut here, BEFORE connectToDatabase() is ever called.
//
//  LAYER 2 — "Counter" (MongoDB, global across all serverless instances)
//      • per-USER requests per minute   (key = verified Telegram id,
//        impossible to spoof because initData is signed)
//      • per-IP   requests per minute   (generous — mobile carriers put many
//        real users behind one IP)
//      • over the SOFT limit  → 429 + Retry-After
//      • over the HARD limit  → goes to Layer 3
//      Once a key is over the limit, this instance remembers it in RAM until
//      the minute ends, so further requests cost NO database operation.
//
//  LAYER 3 — "Ban hammer" (escalating temporary blocks)
//      • 1st offence 10 min → 1 h → 6 h → 24 h (strikes are remembered 24 h)
//      • block stored in `rateBlocks` (TTL auto-cleanup) + cached in RAM
//      • admin gets ONE Telegram alert with a 🔓 Unblock button
//
// SAFETY: if MongoDB errors inside Layer 2/3, the guard FAILS OPEN (request is
// allowed) — a guard bug can never take the bot down. Layer 1 still protects.
//
// Collections (TTL indexes are created automatically, and also listed in
// api/admin/setup-indexes.js):
//   rateLimits { _id: "<u|i|b>:<id>:<minute>", n, expireAt }
//   rateBlocks { _id: "u:<telegramId>" | "i:<ip>", strikes, until, reason, expireAt }

import { connectToDatabase } from './mongodb.js';
import { verifyTelegramInitData } from './telegramAuth.js';
import { tgSend } from './telegram.js';

// ───────────────────────── TUNABLE LIMITS ─────────────────────────
const num = (name, def) => {
    const v = parseInt(process.env[name], 10);
    return Number.isFinite(v) && v > 0 ? v : def;
};

export const LIMITS = {
    MAX_BODY_BYTES:   num('GUARD_MAX_BODY_BYTES', 32 * 1024),

    // Layer 1 (per warm instance, RAM)
    IP_MEM_PER_10S:   num('GUARD_IP_MEM_PER_10S', 60),      // > this in 10s → 429
    IP_MEM_BLOCK_AT:  num('GUARD_IP_MEM_BLOCK_AT', 180),    // > this in 10s → RAM-block IP
    IP_MEM_BLOCK_MS:  num('GUARD_IP_MEM_BLOCK_MS', 5 * 60 * 1000),
    BAD_AUTH_PER_MIN: num('GUARD_BAD_AUTH_PER_MIN', 15),    // invalid initData per IP per minute
    BAD_AUTH_BLOCK_MS: num('GUARD_BAD_AUTH_BLOCK_MS', 10 * 60 * 1000),

    // Layer 2 (global, per minute)
    USER_SOFT:        num('GUARD_USER_SOFT', 90),           // mini-app user: > 90 req/min → 429
    USER_HARD:        num('GUARD_USER_HARD', 180),          // > 180 req/min → temp block
    IP_SOFT:          num('GUARD_IP_SOFT', 300),            // shared carrier IPs → generous
    IP_HARD:          num('GUARD_IP_HARD', 900),            // > 900 req/min from ONE IP → temp block

    // Telegram webhook (a user spamming the bot chat / buttons)
    BOT_SOFT:         num('GUARD_BOT_SOFT', 40),            // > 40 updates/min → silently dropped
    BOT_HARD:         num('GUARD_BOT_HARD', 120),           // > 120 updates/min → temp block
};

// Layer 3 — escalating block durations (strike 1,2,3,4+)
const BLOCK_STEPS_MS = [10 * 60 * 1000, 60 * 60 * 1000, 6 * 3600 * 1000, 24 * 3600 * 1000];
const STRIKE_MEMORY_MS = 24 * 3600 * 1000;
const DB_BLOCK_RAM_TTL_MS = 60 * 1000;   // re-check DB at least once a minute (so Unblock works fast)
const BLOCK_CHECK_CACHE_MS = 30 * 1000;  // "not blocked" answer is cached this long
const ALERTS_PER_MINUTE = 6;             // never let the guard itself spam the admin

const ADMIN_ID = String(process.env.ADMIN_TELEGRAM_ID || '');

// ───────────────────────── RAM STATE (per warm instance) ─────────────────────────
const MAX_KEYS = 20000;                  // hard cap so a flood can't blow up memory
const memBlocks   = new Map();           // key -> blockedUntilMs
const memLimited  = new Map();           // "<kind>:<id>:<minute>" -> { n, escalated }  (already over the soft limit this minute)
const notBlocked  = new Map();           // key -> cacheUntilMs
const ipWindow    = new Map();           // ip -> { t: window start ms, n }
const badAuth     = new Map();           // ip -> { t, n }
let alertWindow = { t: 0, n: 0 };
let indexesEnsured = false;

function sweep(now) {
    for (const m of [memBlocks, notBlocked]) {
        if (m.size > MAX_KEYS / 2) for (const [k, v] of m) if (v <= now) m.delete(k);
    }
    for (const m of [ipWindow, badAuth]) {
        if (m.size > MAX_KEYS / 2) for (const [k, v] of m) if (now - v.t > 70000) m.delete(k);
    }
    if (memLimited.size > MAX_KEYS / 2) {
        const nowMin = Math.floor(now / 60000);
        for (const k of memLimited.keys()) if (Number(k.split(':').pop()) < nowMin) memLimited.delete(k);
    }
    // absolute safety net
    for (const m of [memBlocks, memLimited, notBlocked, ipWindow, badAuth]) {
        if (m.size > MAX_KEYS) m.clear();
    }
}

// ───────────────────────── helpers ─────────────────────────
export function clientIp(req) {
    const h = req.headers || {};
    const v = h['x-vercel-forwarded-for'] || h['x-real-ip'] || (h['x-forwarded-for'] ? String(h['x-forwarded-for']).split(',')[0] : '');
    return String(v || req.socket?.remoteAddress || 'unknown').trim().slice(0, 64) || 'unknown';
}

function reject(res, status, error, retryAfterSec) {
    if (res.headersSent) return true;
    if (retryAfterSec) res.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryAfterSec))));
    res.status(status).json({ ok: false, success: false, error, ...(retryAfterSec ? { retryAfter: Math.ceil(retryAfterSec) } : {}) });
    return true;
}

function ramBlocked(key, now) {
    const until = memBlocks.get(key);
    if (!until) return 0;
    if (until <= now) { memBlocks.delete(key); return 0; }
    return until - now;
}

// A key that is already over its SOFT limit costs no DB op — but the rejected attempts are still
// counted here, and once they pile up past (hard − soft) the key is escalated to Layer 3.
// Returns true exactly once per key/minute when it is time to escalate.
function limitedHit(mapKey, hardGap) {
    const e = memLimited.get(mapKey);
    if (!e) return null;
    e.n++;
    if (!e.escalated && e.n >= hardGap) { e.escalated = true; return 'escalate'; }
    return 'limited';
}

function ensureIndexes(db) {
    if (indexesEnsured) return;
    indexesEnsured = true;
    db.collection('rateLimits').createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 }).catch(() => { indexesEnsured = false; });
    db.collection('rateBlocks').createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 }).catch(() => { indexesEnsured = false; });
}

// one atomic counter per (kind,id,minute)
async function bump(db, kind, id, minute) {
    const _id = `${kind}:${id}:${minute}`;
    const doc = { $inc: { n: 1 }, $setOnInsert: { expireAt: new Date((minute + 3) * 60000) } };
    const opts = { upsert: true, returnDocument: 'after' };
    const col = db.collection('rateLimits');
    try {
        const r = await col.findOneAndUpdate({ _id }, doc, opts);
        return (r?.value ?? r)?.n || 1;
    } catch (e) {
        if (e?.code === 11000) {            // two instances created the doc at the same instant → retry once
            const r = await col.findOneAndUpdate({ _id }, doc, opts);
            return (r?.value ?? r)?.n || 1;
        }
        throw e;
    }
}

async function dbBlockedMs(db, key, now) {
    const cached = notBlocked.get(key);
    if (cached && cached > now) return 0;
    const b = await db.collection('rateBlocks').findOne({ _id: key }, { projection: { until: 1 } });
    const until = b?.until ? new Date(b.until).getTime() : 0;
    if (until > now) {
        memBlocks.set(key, Math.min(until, now + DB_BLOCK_RAM_TTL_MS));
        return until - now;
    }
    notBlocked.set(key, now + BLOCK_CHECK_CACHE_MS);
    return 0;
}

// ───────────────────────── LAYER 3 ─────────────────────────
async function applyBlock(db, key, reason, label) {
    const now = Date.now();
    const col = db.collection('rateBlocks');
    const r = await col.findOneAndUpdate(
        { _id: key },
        { $inc: { strikes: 1 }, $set: { lastReason: reason, lastBlockAt: new Date(now) } },
        { upsert: true, returnDocument: 'after' }
    );
    const strikes = (r?.value ?? r)?.strikes || 1;
    const dur = BLOCK_STEPS_MS[Math.min(strikes - 1, BLOCK_STEPS_MS.length - 1)];
    const until = new Date(now + dur);
    await col.updateOne({ _id: key }, { $set: { until, reason, expireAt: new Date(until.getTime() + STRIKE_MEMORY_MS) } });

    memBlocks.set(key, Math.min(until.getTime(), now + DB_BLOCK_RAM_TTL_MS));
    notBlocked.delete(key);

    // one admin alert per block event (and never more than a few per minute)
    if (ADMIN_ID) {
        if (now - alertWindow.t > 60000) alertWindow = { t: now, n: 0 };
        if (alertWindow.n < ALERTS_PER_MINUTE) {
            alertWindow.n++;
            const mins = Math.round(dur / 60000);
            tgSend(ADMIN_ID,
                `🛡️ <b>Server Guard — flood blocked</b>\n\n` +
                `Target: <code>${label}</code>\nReason: ${reason}\n` +
                `Strike #${strikes} → blocked for <b>${mins >= 60 ? (mins / 60) + ' h' : mins + ' min'}</b>`,
                { reply_markup: { inline_keyboard: [[{ text: '🔓 Unblock', callback_data: `rlun_${key}` }]] } }
            ).catch(() => {});
        }
    }
    return dur;
}

// ───────────────────────── LAYER 1 (shared) ─────────────────────────
function layer1(req, res, now) {
    // body size
    const len = parseInt(req.headers?.['content-length'] || '0', 10);
    if (len > LIMITS.MAX_BODY_BYTES) return { stop: reject(res, 413, 'payload_too_large') };

    const ip = clientIp(req);

    const blockedFor = ramBlocked(`i:${ip}`, now);
    if (blockedFor) return { stop: reject(res, 429, 'rate_limited', blockedFor / 1000) };

    // per-IP burst in a 10-second window (RAM)
    let w = ipWindow.get(ip);
    if (!w || now - w.t > 10000) { w = { t: now, n: 0 }; ipWindow.set(ip, w); }
    w.n++;
    if (w.n > LIMITS.IP_MEM_BLOCK_AT) {
        memBlocks.set(`i:${ip}`, now + LIMITS.IP_MEM_BLOCK_MS);
        return { stop: reject(res, 429, 'rate_limited', LIMITS.IP_MEM_BLOCK_MS / 1000) };
    }
    if (w.n > LIMITS.IP_MEM_PER_10S) return { stop: reject(res, 429, 'rate_limited', 10) };

    return { ip };
}

function noteBadAuth(ip, now) {
    let b = badAuth.get(ip);
    if (!b || now - b.t > 60000) { b = { t: now, n: 0 }; badAuth.set(ip, b); }
    b.n++;
    if (b.n > LIMITS.BAD_AUTH_PER_MIN) memBlocks.set(`i:${ip}`, now + LIMITS.BAD_AUTH_BLOCK_MS);
}

// ───────────────────────── LAYER 2 + 3 core ─────────────────────────
async function countAndJudge({ kind, uid, ip, soft, hard, now }) {
    const minute = Math.floor(now / 60000);
    const secsLeft = 60 - Math.floor((now % 60000) / 1000);
    const uKey = uid ? `u:${uid}` : null;
    const iKey = `i:${ip}`;

    // already known to be over the limit this minute on this instance → no DB op (escalate to a block if it keeps hammering)
    if (uid) {
        const st = limitedHit(`${kind}:${uid}:${minute}`, hard - soft);
        if (st === 'escalate') {
            const { db } = await connectToDatabase();
            const dur = await applyBlock(db, uKey, `kept sending requests after the ${soft}/min limit (${hard - soft}+ extra in one minute)`, uKey);
            return { status: 429, error: 'rate_limited', retry: dur / 1000 };
        }
        if (st) return { status: 429, error: 'rate_limited', retry: secsLeft };
    }
    {
        const st = limitedHit(`i:${ip}:${minute}`, LIMITS.IP_HARD - LIMITS.IP_SOFT);
        if (st === 'escalate') {
            const { db } = await connectToDatabase();
            const dur = await applyBlock(db, iKey, `kept sending requests after the ${LIMITS.IP_SOFT}/min IP limit`, iKey);
            return { status: 429, error: 'rate_limited', retry: dur / 1000 };
        }
        if (st) return { status: 429, error: 'rate_limited', retry: secsLeft };
    }

    const { db } = await connectToDatabase();
    ensureIndexes(db);

    // Layer 3 check (cached → ~1 read / 30 s / key / instance)
    const [bu, bi] = await Promise.all([
        uKey ? dbBlockedMs(db, uKey, now) : 0,
        dbBlockedMs(db, iKey, now),
    ]);
    if (bu || bi) return { status: 429, error: 'rate_limited', retry: Math.max(bu, bi) / 1000 };

    // Layer 2 counters
    const [uN, iN] = await Promise.all([
        uid ? bump(db, kind, uid, minute) : 0,
        bump(db, 'i', ip, minute),
    ]);

    if (uid && uN > hard) {
        const dur = await applyBlock(db, uKey, `${uN} requests in 1 minute (limit ${hard})`, uKey);
        return { status: 429, error: 'rate_limited', retry: dur / 1000 };
    }
    if (iN > LIMITS.IP_HARD) {
        const dur = await applyBlock(db, iKey, `${iN} requests/min from one IP (limit ${LIMITS.IP_HARD})`, iKey);
        return { status: 429, error: 'rate_limited', retry: dur / 1000 };
    }
    if (uid && uN > soft) { memLimited.set(`${kind}:${uid}:${minute}`, { n: 0, escalated: false }); return { status: 429, error: 'rate_limited', retry: secsLeft }; }
    if (iN > LIMITS.IP_SOFT) { memLimited.set(`i:${ip}:${minute}`, { n: 0, escalated: false }); return { status: 429, error: 'rate_limited', retry: secsLeft }; }
    return null;
}

// ═════════════════════════ PUBLIC API ═════════════════════════

// Mini-app endpoints (api/user, earn, withdraw, gift, payments).
// Call FIRST in the handler, before connectToDatabase():
//     if (await guard(req, res)) return;
// Returns true when the request was rejected (response already sent).
//
// opts.auth = false → public endpoint (no Telegram session): IP limits only.
export async function guard(req, res, opts = {}) {
    try {
        const now = Date.now();
        sweep(now);

        const l1 = layer1(req, res, now);
        if (l1.stop) return true;
        const ip = l1.ip;

        let uid = null;
        if (opts.auth !== false) {
            const initData = req.body?.initData ?? req.query?.initData;
            const v = (typeof initData === 'string' && initData.length < 4096) ? verifyTelegramInitData(initData) : { ok: false, error: 'missing_init_data' };
            if (!v.ok) {
                noteBadAuth(ip, now);
                return reject(res, 401, 'unauthorized');
            }
            uid = String(v.user.id);
            if (ADMIN_ID && uid === ADMIN_ID) return false;      // admin is never throttled

            const ub = ramBlocked(`u:${uid}`, now);
            if (ub) return reject(res, 429, 'rate_limited', ub / 1000);
        }

        const verdict = await countAndJudge({
            kind: 'u', uid, ip, soft: LIMITS.USER_SOFT, hard: LIMITS.USER_HARD, now,
        });
        if (verdict) return reject(res, verdict.status, verdict.error, verdict.retry);
        return false;
    } catch (e) {
        console.error('guard error (failing open):', e?.message);
        return false;                                            // never take the bot down because of the guard
    }
}

// Public read-only endpoints (api/data.js): Layer 1 + IP-only Layer 2.
export const guardPublic = (req, res) => guard(req, res, { auth: false });

// Telegram webhook (api/bot.js). The webhook secret is already verified by the
// caller, so every update is a real Telegram update — this stops ONE user from
// spamming the bot chat / buttons. Throttled updates are DROPPED SILENTLY with
// HTTP 200 (so Telegram doesn't retry) and the bot sends NOTHING back.
// Returns true → caller should `return res.status(200).json({ ok: true })`.
export async function guardWebhook(update, req) {
    try {
        const from = update?.message?.from || update?.callback_query?.from || update?.edited_message?.from
            || update?.pre_checkout_query?.from || update?.my_chat_member?.from || update?.chat_join_request?.from;
        const uid = from?.id ? String(from.id) : null;
        if (!uid) return false;
        if (ADMIN_ID && uid === ADMIN_ID) return false;
        if (process.env.TASK_MODERATOR_ID && uid === String(process.env.TASK_MODERATOR_ID)) return false;

        const now = Date.now();
        sweep(now);
        if (ramBlocked(`u:${uid}`, now)) return true;

        // webhook traffic comes from Telegram's IPs, so only the per-user key matters here
        const minute = Math.floor(now / 60000);
        const st = limitedHit(`b:${uid}:${minute}`, LIMITS.BOT_HARD - LIMITS.BOT_SOFT);
        if (st === 'escalate') {
            const { db } = await connectToDatabase();
            await applyBlock(db, `u:${uid}`, `kept spamming the bot after the ${LIMITS.BOT_SOFT}/min limit`, `u:${uid}`);
            return true;
        }
        if (st) return true;

        const { db } = await connectToDatabase();
        ensureIndexes(db);

        if (await dbBlockedMs(db, `u:${uid}`, now)) return true;

        const n = await bump(db, 'b', uid, minute);
        if (n > LIMITS.BOT_HARD) { await applyBlock(db, `u:${uid}`, `${n} bot updates in 1 minute (limit ${LIMITS.BOT_HARD})`, `u:${uid}`); return true; }
        if (n > LIMITS.BOT_SOFT) { memLimited.set(`b:${uid}:${minute}`, { n: 0, escalated: false }); return true; }
        return false;
    } catch (e) {
        console.error('guardWebhook error (failing open):', e?.message);
        return false;
    }
}

// Admin "🔓 Unblock" button (bot.js callback `rlun_<key>`)
export async function unblockKey(db, key) {
    memBlocks.delete(key);
    notBlocked.set(key, Date.now() + BLOCK_CHECK_CACHE_MS);
    const r = await db.collection('rateBlocks').deleteOne({ _id: key });
    return r.deletedCount > 0;
                                }
