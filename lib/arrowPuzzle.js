// lib/arrowPuzzle.js — Arrow Puzzle backend (games/arrow-puzzle.html), served through api/earn.js
//   { action: 'arrowStatus',  initData }
//   { action: 'arrowStart',   initData, level, token }
//   { action: 'arrowFinish',  initData, id, won, abandoned, ms, mistakes, moves:[arrowId…] }
//   { action: 'arrowGateAd',  initData, gateId, purpose:'reward1'|'reward2'|'retry', adSession, proof }
//
// Everything that matters is decided HERE, from the verified Telegram user (never from the body):
//   • Attempt limit  — max ARROW_MAX_DAILY starts per Bangladesh day (UTC+6), counted at START.
//   • Cooldown       — now must be ≥ lastStart + 1 h. lastStart survives midnight.
//   • Level progress — a level unlocks ONLY after the server re-plays the submitted taps
//                      (lib/arrowEngine.js, identical to the game's engine) and they clear the board with 0 mistakes.
//   • Coin reward    — credited ONLY by arrowGateAd after the ad proof is verified server-to-server, once per
//                      (gate, step) via an idempotency key, 15 + 15 = 30 per level at most.
//
// All state of one player is ONE document (collection `arrowPuzzle`, _id = userId), and every transition is a
// single conditional update, so double-taps / parallel requests / replays cannot skip a rule.
//   { _id, day:'YYYY-MM-DD'(BD), used, lastStart, lastToken, unlocked, done:[levels],
//     current:null|{id,token,level,t}, gate:null|{id,kind:'reward'|'retry',level,collected} }

import crypto from 'crypto';
import { buildLevel, replay } from './arrowEngine.js';
import {
    ARROW_MAX_DAILY, ARROW_COOLDOWN_MS, ARROW_LIVES, ARROW_LEVELS,
    ARROW_REWARD_PER_AD, ARROW_REWARD_TOTAL, ARROW_MIN_MS_PER_MOVE,
} from './constants.js';

const BD_OFFSET_MS = 6 * 3600 * 1000;
const DAY_MS = 86400000;
const bdDay = (now = Date.now()) => new Date(now + BD_OFFSET_MS).toISOString().slice(0, 10);
const nextResetAt = (now = Date.now()) => (Math.floor((now + BD_OFFSET_MS) / DAY_MS) + 1) * DAY_MS - BD_OFFSET_MS;
const PURPOSES = new Set(['reward1', 'reward2', 'retry']);
const isStr = (v, max) => typeof v === 'string' && v.length >= 1 && v.length <= max;

// ── Ad proof verification ──────────────────────────────────────────────────────────────────────────────────
// No rewarded-ad network is connected to Arrow Puzzle yet, so there is NOTHING that can honestly prove an ad was
// watched. Until a verifier is registered here, every ad step is refused and NO coin is ever credited.
// To connect a network later: add  ARROW_AD_VERIFIERS.<name> = async ({ userId, gateId, purpose, adSession, proof }) => boolean
// (it must check `proof` with the network SERVER-TO-SERVER) and set env ARROW_AD_PROVIDER=<name>.
export const ARROW_AD_VERIFIERS = {};
async function verifyAdProof(args) {
    const fn = ARROW_AD_VERIFIERS[process.env.ARROW_AD_PROVIDER || ''];
    if (typeof fn !== 'function') return { configured: false, ok: false };
    try { return { configured: true, ok: (await fn(args)) === true }; } catch (e) { return { configured: true, ok: false }; }
}

// ── state helpers ──────────────────────────────────────────────────────────────────────────────────────────
async function loadState(db, userId, keepToken = null) {
    const col = db.collection('arrowPuzzle'), today = bdDay();
    try {
        await col.updateOne({ _id: userId }, { $setOnInsert: { day: today, used: 0, lastStart: 0, lastToken: null, unlocked: 1, done: [], current: null, gate: null } }, { upsert: true });
    } catch (e) { if (e?.code !== 11000) throw e; } // two first requests raced → the other one created it
    await col.updateOne({ _id: userId, day: { $ne: today } }, { $set: { day: today, used: 0 } }); // new BD day → attempts reset (lastStart is kept)
    let s = await col.findOne({ _id: userId });
    // A run that is still 'started' when a request arrives from a fresh page means the player left it: it failed → retry gate.
    if (s?.current && !s.gate && s.current.token !== keepToken) { // (a retried /start with the SAME token is not an orphan)
        await col.updateOne({ _id: userId, 'current.id': s.current.id, gate: null },
            { $set: { current: null, gate: { id: s.current.id, kind: 'retry', level: s.current.level, collected: 0 } } });
        s = await col.findOne({ _id: userId });
    }
    return s;
}
async function checkUser(db, userId) {
    const u = await db.collection('users').findOne({ _id: userId }, { projection: { isBanned: 1 } });
    if (!u) return { error: 'user_not_found', status: 404 };
    if (u.isBanned) return { error: 'banned', status: 403 };
    return { ok: true };
}
const publicState = (s) => ({
    used: s.used, max: ARROW_MAX_DAILY, limit: ARROW_MAX_DAILY,
    cooldownUntil: s.lastStart ? s.lastStart + ARROW_COOLDOWN_MS : 0, resetAt: nextResetAt(),
    gate: s.gate ? { id: s.gate.id, kind: s.gate.kind, level: s.gate.level, collected: s.gate.collected || 0 } : null,
    unlocked: s.unlocked, done: s.done || [],
});
function startRefusal(s, level, now) {
    if (s.gate) return { reason: 'gate' };
    if (s.used >= ARROW_MAX_DAILY) return { reason: 'limit' };
    if (now < s.lastStart + ARROW_COOLDOWN_MS) return { reason: 'cooldown', until: s.lastStart + ARROW_COOLDOWN_MS };
    if (level > s.unlocked) return { reason: 'locked' };
    return null;
}

// ── arrowStatus ──  `secure:true` is what lets the game drop its "Local demo mode" warning: it is only ever sent
// by this code path, after a real, authenticated database read.
export async function handleArrowStatus(req, res, db, userId) {
    const c = await checkUser(db, userId);
    if (!c.ok) return res.status(c.status).json({ ok: false, error: c.error });
    const s = await loadState(db, userId);
    return res.status(200).json({ ok: true, secure: true, ...publicState(s) });
}

// ── arrowStart ──
export async function handleArrowStart(req, res, db, userId) {
    const level = Number(req.body?.level), token = req.body?.token;
    if (!Number.isInteger(level) || level < 1 || level > ARROW_LEVELS) return res.status(400).json({ ok: false, error: 'invalid_level' });
    if (!isStr(token, 100)) return res.status(400).json({ ok: false, error: 'invalid_token' });
    const c = await checkUser(db, userId);
    if (!c.ok) return res.status(c.status).json({ ok: false, error: c.error });

    const col = db.collection('arrowPuzzle');
    const s0 = await loadState(db, userId, token);
    if (s0.current?.token === token) return res.status(200).json({ ok: true, id: s0.current.id, used: s0.used }); // same token = same attempt
    if (s0.lastToken === token) return res.status(200).json({ ok: false, reason: 'gate' });                       // that attempt already ended
    const now = Date.now();
    const refuse = startRefusal(s0, level, now);
    if (refuse) return res.status(200).json({ ok: false, ...refuse });

    const id = crypto.randomUUID();
    const upd = await col.findOneAndUpdate(
        { _id: userId, day: bdDay(now), gate: null, current: null, used: { $lt: ARROW_MAX_DAILY }, lastStart: { $lte: now - ARROW_COOLDOWN_MS }, unlocked: { $gte: level } },
        { $inc: { used: 1 }, $set: { lastStart: now, lastToken: token, current: { id, token, level, t: now } } },
        { returnDocument: 'after' }
    );
    if (!upd) { // a parallel request won the race — report the real reason
        const s1 = await loadState(db, userId, token);
        if (s1.current?.token === token) return res.status(200).json({ ok: true, id: s1.current.id, used: s1.used });
        return res.status(200).json({ ok: false, ...(startRefusal(s1, level, Date.now()) || { reason: 'gate' }) });
    }
    return res.status(200).json({ ok: true, id, used: upd.used });
}

// ── arrowFinish ──
export async function handleArrowFinish(req, res, db, userId) {
    const { id, won, abandoned, moves } = req.body || {};
    if (!isStr(id, 100)) return res.status(400).json({ ok: false, error: 'invalid_id' });
    const col = db.collection('arrowPuzzle');
    const s = await col.findOne({ _id: userId });
    if (!s || !s.current || s.current.id !== id) return res.status(200).json({ ok: false }); // only while 'started'
    const level = s.current.level;

    let valid = false;
    if (won === true) {
        const lv = buildLevel(level), n = lv.arrows.length;
        const okMoves = Array.isArray(moves) && moves.length <= n * 2 && moves.every(m => Number.isInteger(m));
        if (okMoves) {
            const v = replay(level, moves); // the server re-plays the taps on the exact board of this level
            const elapsed = Date.now() - s.current.t;
            valid = v.valid && v.cleared && v.mistakes < ARROW_LIVES && elapsed >= n * ARROW_MIN_MS_PER_MOVE;
        }
    }
    const gate = { id, kind: valid ? 'reward' : 'retry', level, collected: 0 };
    const update = { $set: { current: null, gate } };
    if (valid) { update.$addToSet = { done: level }; update.$max = { unlocked: Math.min(ARROW_LEVELS, level + 1) }; }
    const r = await col.updateOne({ _id: userId, 'current.id': id }, update); // atomic: only the first finish for this attempt counts
    if (!r.modifiedCount) return res.status(200).json({ ok: false });
    return res.status(200).json({ ok: valid });
}

// ── arrowGateAd ──
export async function handleArrowGateAd(req, res, db, userId, { eligibleFilter }) {
    const { gateId, purpose, adSession, proof } = req.body || {};
    if (!isStr(gateId, 100) || !PURPOSES.has(purpose) || !isStr(adSession, 200) || !isStr(proof, 2000)) return res.status(400).json({ ok: false, error: 'invalid_request' });
    const col = db.collection('arrowPuzzle');
    const s = await col.findOne({ _id: userId });
    const g = s?.gate;
    if (!g || g.id !== gateId) return res.status(200).json({ ok: false, reason: 'no_gate' });
    const collected = g.collected || 0;
    const fits = purpose === 'retry' ? g.kind === 'retry' : g.kind === 'reward' && (purpose === 'reward1' ? collected === 0 : collected === 1);
    if (!fits) return res.status(200).json({ ok: false, reason: 'wrong_step' });

    // 1) real ad proof, verified server-to-server. No verifier connected → refuse, change nothing, credit nothing.
    const v = await verifyAdProof({ userId, gateId, purpose, adSession, proof });
    if (!v.configured) return res.status(200).json({ ok: false, reason: 'ad_not_configured' });
    if (!v.ok) return res.status(200).json({ ok: false, reason: 'ad_unverified' });

    // 2) each ad session and each proof can be spent once, ever
    const proofs = db.collection('arrowAdProofs');
    const sha = crypto.createHash('sha256').update(proof).digest('hex');
    try { await proofs.insertMany([{ _id: 'sess:' + adSession, userId, gateId, purpose, at: new Date() }, { _id: 'proof:' + sha, userId, gateId, purpose, at: new Date() }], { ordered: true }); }
    catch (e) { if (e?.code === 11000 || e?.writeErrors) return res.status(200).json({ ok: false, reason: 'ad_reused' }); throw e; }

    // 3) coins (reward steps only) — idempotent: one payout per (gate, step), so a level can never pay more than 30
    let balance = null;
    if (purpose !== 'retry') {
        const key = `arrow:${gateId}:${purpose}`, log = db.collection('arrowRewards');
        let paidBefore = false;
        try { await log.insertOne({ _id: key, userId, gateId, purpose, amount: ARROW_REWARD_PER_AD, at: new Date() }); }
        catch (e) { if (e?.code === 11000) paidBefore = true; else throw e; }
        if (!paidBefore) {
            const paid = await db.collection('users').findOneAndUpdate(
                { _id: userId, isBanned: { $ne: true }, ...eligibleFilter },
                { $inc: { wtcBalance: ARROW_REWARD_PER_AD, lifetimeWtcEarned: ARROW_REWARD_PER_AD } },
                { returnDocument: 'after' }
            );
            if (!paid) { await log.deleteOne({ _id: key }); return res.status(200).json({ ok: false, reason: 'not_eligible' }); }
            balance = paid.wtcBalance;
        }
    }

    // 4) advance / close the gate (only if it is still exactly the step we verified)
    const done = purpose === 'reward1'
        ? await col.updateOne({ _id: userId, 'gate.id': gateId, 'gate.collected': 0 }, { $set: { 'gate.collected': 1 } })
        : await col.updateOne({ _id: userId, 'gate.id': gateId }, { $set: { gate: null } });
    if (!done.modifiedCount) return res.status(200).json({ ok: false, reason: 'no_gate' });
    return res.status(200).json({ ok: true, collected: purpose === 'reward1' ? 1 : 2, reward: purpose === 'retry' ? 0 : ARROW_REWARD_PER_AD, balance, total: ARROW_REWARD_TOTAL });
}
