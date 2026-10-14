// lib/miniBot.js — Earn › VYROVA Mini Bot (games/mini-bot.html)
//
// The game runs entirely on the player's phone, so the server can never *see* the gameplay.
// What it can do (and does here) is make cheating pointless:
//   • miniBotStart  → issues a signed, single-use run token (HMAC, same pattern as spinStart).
//   • miniBotClaim  → re-validates the reported result, then credits in ONE atomic update that also
//                     (a) burns the token, (b) enforces the daily-run cap, (c) applies REWARD_ELIGIBLE_FILTER.
// Hard ceilings: 30 enemy coins + 170 boss coins per run, the boss part only if the boss was reported
// killed AND enough real time passed, and at most MINI_BOT_DAILY_RUNS_MAX paid runs per BD day.
// A forged request can therefore win at most the ceiling, and only after real elapsed time.

import { ensureDailyReset } from './dailyReset.js';
import {
    MINI_BOT_ENEMY_COIN_CAP, MINI_BOT_BOSS_COIN, MINI_BOT_DAILY_RUNS_MAX,
    MINI_BOT_MIN_SECONDS_PER_COIN, MINI_BOT_BOSS_MIN_SECONDS, MINI_BOT_TOKEN_MAX_SECONDS,
} from './constants.js';

// Pure: turns the client's report into the amount that may be paid (or an error code).
export function validateRun({ coins, bossKilled }, elapsedSeconds) {
    if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) return { error: 'invalid_run_token' };
    if (elapsedSeconds > MINI_BOT_TOKEN_MAX_SECONDS) return { error: 'run_token_expired' };
    const c = Math.floor(Number(coins));
    if (!Number.isFinite(c) || c < 0) return { error: 'invalid_result' };
    const killed = bossKilled === true;
    // enemy part: capped, and needs real play time
    let enemy = Math.min(c, MINI_BOT_ENEMY_COIN_CAP + (killed ? MINI_BOT_BOSS_COIN : 0));
    let boss = 0;
    if (killed) {
        // anything above the enemy cap can only be the boss reward
        enemy = Math.min(c, MINI_BOT_ENEMY_COIN_CAP);
        if (elapsedSeconds < MINI_BOT_BOSS_MIN_SECONDS) return { error: 'run_too_short' };
        boss = MINI_BOT_BOSS_COIN;
    } else {
        enemy = Math.min(c, MINI_BOT_ENEMY_COIN_CAP);
    }
    if (enemy * MINI_BOT_MIN_SECONDS_PER_COIN > elapsedSeconds) return { error: 'run_too_short' };
    return { reward: enemy + boss, enemy, boss };
}

export async function handleMiniBotStatus(req, res, db, userId) {
    const users = db.collection('users');
    await ensureDailyReset(users, userId);
    const u = await users.findOne({ _id: userId }, { projection: { miniBotRunsToday: 1 } });
    if (!u) return res.status(404).json({ ok: false, error: 'user_not_found' });
    const used = u.miniBotRunsToday || 0;
    return res.status(200).json({ ok: true, runsToday: used, runsMax: MINI_BOT_DAILY_RUNS_MAX, runsLeft: Math.max(0, MINI_BOT_DAILY_RUNS_MAX - used), maxReward: MINI_BOT_ENEMY_COIN_CAP + MINI_BOT_BOSS_COIN });
}

// Issues a run token. Does NOT consume a run (an abandoned game costs nothing) — the cap is enforced at claim.
export async function handleMiniBotStart(req, res, db, userId, { signRun }) {
    const users = db.collection('users');
    await ensureDailyReset(users, userId);
    const u = await users.findOne({ _id: userId }, { projection: { miniBotRunsToday: 1, isBanned: 1 } });
    if (!u) return res.status(404).json({ ok: false, error: 'user_not_found' });
    if (u.isBanned) return res.status(403).json({ ok: false, error: 'banned' });
    const used = u.miniBotRunsToday || 0;
    const startTime = Date.now();
    return res.status(200).json({
        ok: true, startTime, signature: signRun(userId, startTime),
        runsLeft: Math.max(0, MINI_BOT_DAILY_RUNS_MAX - used), runsMax: MINI_BOT_DAILY_RUNS_MAX,
        paid: used < MINI_BOT_DAILY_RUNS_MAX, // false → the player may still play for fun, but nothing will be paid
    });
}

export async function handleMiniBotClaim(req, res, db, userId, { signRun, eligibleFilter }) {
    const { startTime, signature, coins, bossKilled, score } = req.body || {};
    if (!startTime || !signature) return res.status(400).json({ ok: false, error: 'missing_run_token' });
    if (signRun(userId, startTime) !== signature) return res.status(400).json({ ok: false, error: 'invalid_run_token' });

    const v = validateRun({ coins, bossKilled }, (Date.now() - Number(startTime)) / 1000);
    if (v.error) return res.status(400).json({ ok: false, error: v.error });
    if (v.reward <= 0) return res.status(200).json({ ok: true, reward: 0 }); // nothing earned → nothing to record

    const users = db.collection('users');
    await ensureDailyReset(users, userId);
    const key = String(startTime); // single-use, same pattern as usedSpinStarts
    const credited = await users.findOneAndUpdate(
        {
            _id: userId, isBanned: { $ne: true }, usedMiniBotStarts: { $ne: key },
            $and: [
                { $or: [{ miniBotRunsToday: { $exists: false } }, { miniBotRunsToday: { $lt: MINI_BOT_DAILY_RUNS_MAX } }] },
                eligibleFilter,
            ],
        },
        {
            $inc: { wtcBalance: v.reward, lifetimeWtcEarned: v.reward, miniBotRunsToday: 1 },
            $addToSet: { usedMiniBotStarts: key },
        },
        { returnDocument: 'after' }
    );

    if (!credited) {
        const u = await users.findOne({ _id: userId }, { projection: { isBanned: 1, multiAccountFlag: 1, channelVerified: 1, usedMiniBotStarts: 1, miniBotRunsToday: 1 } });
        if (!u) return res.status(404).json({ ok: false, error: 'user_not_found' });
        if (u.isBanned) return res.status(403).json({ ok: false, error: 'banned' });
        if ((u.usedMiniBotStarts || []).includes(key)) return res.status(400).json({ ok: false, error: 'run_token_already_used' });
        if ((u.miniBotRunsToday || 0) >= MINI_BOT_DAILY_RUNS_MAX) return res.status(200).json({ ok: true, reward: 0, limitReached: true, runsLeft: 0 });
        return res.status(403).json({ ok: false, error: 'account_under_review' });
    }

    try {
        await db.collection('miniBotLogs').insertOne({
            userId: String(userId), reward: v.reward, enemy: v.enemy, boss: v.boss, bossKilled: v.boss > 0,
            score: Math.max(0, Math.min(1e9, Math.floor(Number(score) || 0))),
            seconds: Math.round((Date.now() - Number(startTime)) / 1000), createdAt: new Date(),
        });
    } catch (e) { /* history is best-effort — never blocks the reward */ }

    return res.status(200).json({
        ok: true, reward: v.reward, enemy: v.enemy, boss: v.boss,
        balance: credited.wtcBalance, runsLeft: Math.max(0, MINI_BOT_DAILY_RUNS_MAX - (credited.miniBotRunsToday || 0)),
    });
}
