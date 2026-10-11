// api/earn.js — CONSOLIDATED + SECURITY FIX (Telegram initData verification)
//
// Previously every action trusted the client-supplied userId. Now every
// request requires a verified initData, and the userId extracted from it is
// the only one used — the client can never act as someone else by sending a
// different userId.
//
// every WTC-crediting action now also checks
// REWARD_ELIGIBLE_FILTER — a multi-account-flagged user earns NOTHING new
// until they verify channel+community membership. This is NOT retroactive
// (no held/pending balance to release later) — reward simply stays blocked
// until verified, then unblocks going forward. Progress/counters still
// advance normally EXCEPT completedTasks (see handleTaskComplete for why).
//
// claimAdReward used to trust the client's
// bare `{ network }` with zero proof an ad was ever shown. A script that
// simply replayed the same POST request (found being distributed publicly —
// a Termux-based auto-farming bot targeting this exact endpoint) could drain
// the daily ad reward in seconds without watching anything. Fixed the same
// way videoClaim already protects itself: the client must first request a
// short-lived signed token (adStart) — issued the moment the user taps
// "Watch" — then submit that exact token back with claimAdReward. The
// server verifies: (1) the HMAC signature is genuine, (2) at least
// AD_MIN_WATCH_SECONDS has elapsed since the token was issued, (3) the token
// hasn't been spent already (single-use, atomic, mirrors usedVideoStarts).
// This doesn't require watching pixel-perfect ad content, but it closes the
// "call claimAdReward directly with no ad token at all" hole that the bot
// script exploited, and rate-limits any script that adapts to still call
// adStart first.
//
//   { action: 'videoStart',    initData }
//   { action: 'videoClaim',    initData, startTime, signature, claimedPoints }
//   { action: 'lootboxAdStart', initData }                                    — ⚠️ NEW, security fix
//   { action: 'claimLootbox',  initData, startTime, signature }               — ⚠️ CHANGED, was { adWatched: true }
//   { action: 'adStart',       initData, network }
//   { action: 'claimAdReward', initData, network, startTime, signature }
//   { action: 'taskComplete',  initData, taskId, startTime?, signature? }  — ⚠️ CHANGED, startTime/signature now required for non-'channel' categories
//   { action: 'taskStart',     initData, taskId }                          — ⚠️ NEW, security fix
//   { action: 'claimPromo',    initData, code }

import crypto from 'crypto';
import { ObjectId } from 'mongodb';
import { connectToDatabase } from '../lib/mongodb.js';
import { isMember, tgSend } from '../lib/telegram.js';
import { ensureDailyReset } from '../lib/dailyReset.js';
import { maybeAwardReferralMilestones } from '../lib/referral.js';
import { verifyTelegramInitData } from '../lib/telegramAuth.js';
import { detectBotPattern, detectVideoBotPattern, lockForBotPattern, AD_CLAIM_HISTORY_KEEP, VIDEO_CLAIM_HISTORY_KEEP } from '../lib/botGuard.js';
import {
    LOOTBOX_CLAIM_MIN, LOOTBOX_CLAIM_MAX, DAILY_VIDEO_WTC_MAX, VIDEO_WTC_PER_SECOND,
    AD_NETWORK_REWARDS, AD_MIN_WATCH_SECONDS, AD_VIEW_TOLERANCE_SECONDS, AD_COOLDOWN_SECONDS, TASK_MIN_WAIT_SECONDS, TASK_COOLDOWN_SECONDS,
    SPIN_FREE_COOLDOWN_HOURS, SPIN_SEGMENTS, TERMS_VERSION,
    GAME_PLAY_SECONDS, GAME_CLAIM_MIN, GAME_CLAIM_MAX, GAME_DAILY_CLAIMS_MAX,
    SPIN_MIN_GAP_SECONDS, BONUS_SPINS_MAX_PER_DAY, SPIN_BLOCK_ALERT_COUNT, SPIN_BLOCK_ALERT_WINDOW_MS, SPIN_BOT_MIN_SPINS, SPIN_BOT_MAX_GAP_MS, SPIN_BOT_MAX_SPREAD_MS,
    STREAK_REWARDS, STREAK_AD_MIN_SECONDS, todayStartBD,
} from '../lib/constants.js';

const SECRET = process.env.VIDEO_SIGNING_SECRET;
const sign = (userId, startTime) => crypto.createHmac('sha256', SECRET).update(`${userId}:${startTime}`).digest('hex');

// separate signing namespace for ad-watch tokens (same secret, but
// prefixed + includes the network name, so an ad-token can never be replayed
// as a video-token or vice versa, and a token for one network can't be
// reused to claim a different network's reward).
const signAdStart = (userId, network, startTime) =>
    crypto.createHmac('sha256', SECRET).update(`ad:${userId}:${network}:${startTime}`).digest('hex');

// separate signing namespace for the
// lootbox ad-gate token. Mirrors signAdStart exactly. See handleClaimLootbox
// for why this was added: the previous version trusted a bare client-sent
// `{ adWatched: true }` boolean with zero proof, letting anyone skip the
// mandatory ad via a direct API call (found during a security review — same
// exploit class as the earlier Termux ad-farming bot, just on a different
// endpoint that never got the same fix at the time).
const signLootboxStart = (userId, startTime) =>
    crypto.createHmac('sha256', SECRET).update(`lootbox:${userId}:${startTime}`).digest('hex');

// separate signing namespace for task-claim tokens. Mirrors
// signAdStart exactly: includes taskId so a token for one task can never be
// replayed to claim a different task.
const signTaskStart = (userId, taskId, startTime) =>
    crypto.createHmac('sha256', SECRET).update(`task:${userId}:${taskId}:${startTime}`).digest('hex');

// separate signing namespace for the Spin Wheel's
// ad-gate token. Mirrors signAdStart/signLootboxStart exactly. See
// handleSpin below for why this was added: the free spin previously had
// ZERO server-side proof that its "watch an ad first" cost was actually
// paid — the frontend just called the ad SDK directly and then hit `spin`
// with nothing to check, so a script could call `spin` in a raw loop
// limited only by the old daily counter.
const signSpinStart = (userId, startTime) =>
    crypto.createHmac('sha256', SECRET).update(`spin:${userId}:${startTime}`).digest('hex');

// the channelVerified bypass below used to
// apply unconditionally to ANY flagged account. Since joining the
// channel/community is mandatory just to use the app at all (the join-gate
// every user passes through), that bypass was satisfied automatically by
// normal use — in practice it blocked nobody. Combined with the
// zero-cost-for-fresh-accounts "Switch Account" gap (see lib/ipRegistry.js),
// someone could spin up unlimited fresh accounts on one device and each one
// would earn completely normally the moment they joined the channel (which
// they'd do anyway). Now the bypass only applies up to
// MULTI_ACCOUNT_SIBLING_HARD_LIMIT other accounts sharing this device's
// fingerprint — plausible for a family/shared device. Beyond that (a device
// with many more accounts on it — a much stronger farming signal), earning
// stays blocked even after channel-verifying; unblocking those needs an
// admin to actually clear multiAccountFlag after review (admin-panel button
// for that is a separate follow-up, not yet built).
const MULTI_ACCOUNT_SIBLING_HARD_LIMIT = 2;
const REWARD_ELIGIBLE_FILTER = {
    $or: [
        { multiAccountFlag: { $ne: true } },
        {
            $and: [
                { channelVerified: true },
                { $expr: { $lte: [{ $size: { $ifNull: ['$multiAccountSiblings', []] } }, MULTI_ACCOUNT_SIBLING_HARD_LIMIT] } },
            ],
        },
    ],
};

// ── videoClaim ──
// the previous version verified the signature correctly, but
// never recorded that a given (userId, startTime) session had already been
// claimed. That meant the *same* signed startTime could be replayed via
// repeated claimAdReward-style calls — each replay recomputed `award` from
// the FULL elapsed time since the original startTime (not since the last
// claim), so spacing out replays over real wall-clock time compounded into
// far more WTC than a single honest claim would ever yield, letting someone
// script their way to the daily cap without watching anything. Now each
// startTime is single-use: it's atomically added to `usedVideoStarts` in the
// very same update that credits the reward, and the filter rejects any
// startTime already present in that array — so a replayed session earns
// nothing the second time around, full stop.
//
// ⚠️ NOTE: no REWARD_ELIGIBLE_FILTER here on purpose — videoClaim only moves
// WTC into `pendingVideoWTC` (not yet real balance), the actual credit
// happens at claimLootbox, which IS gated. Blocking here too would just
// silently stall the pending-accrual UI with no benefit.
async function handleVideoClaim(req, res, db, userId) {
    const { startTime, signature, claimedPoints } = req.body;
    if (!startTime || !signature || claimedPoints === undefined) {
        return res.status(400).json({ ok: false, error: 'missing_fields' });
    }
    if (sign(userId, startTime) !== signature) {
        return res.status(400).json({ ok: false, error: 'invalid_signature' });
    }
    const elapsedSeconds = (Date.now() - Number(startTime)) / 1000;
    if (elapsedSeconds < 0) return res.status(400).json({ ok: false, error: 'invalid_time' });
    // this token had no upper-bound expiry,
    // unlike its siblings (adStart/lootboxAdStart/taskStart tokens all
    // expire after 300s). Combined with the videoStart auth bypass above (now
    // fixed), a token could be minted once and held indefinitely, then
    // claimed later using pure elapsed real time with no session/ad ever
    // open. The daily/per-claim caps already limited the payout size, but
    // this closes the token-hoarding angle entirely, matching the pattern
    // used everywhere else in this file. Legit flow is unaffected — the
    // client requests a fresh token immediately after every successful
    // claim (see index.html startVideoSession, ~30s cadence).
    if (elapsedSeconds > 300) return res.status(400).json({ ok: false, error: 'video_token_expired' });

    const maxEarnable = Math.min(LOOTBOX_CLAIM_MAX, Math.floor(elapsedSeconds * VIDEO_WTC_PER_SECOND));
    const requested = Math.floor(Number(claimedPoints));
    if (isNaN(requested) || requested <= 0) return res.status(400).json({ ok: false, error: 'invalid_amount' });
    const award = Math.min(requested, maxEarnable);
    if (award <= 0) return res.status(400).json({ ok: false, error: 'insufficient_watch_time' });

    const users = db.collection('users');
    await ensureDailyReset(users, userId);

    const userCheck = await users.findOne({ _id: userId }, { projection: { isBanned: 1, pendingVideoWTC: 1, accountLocked: 1, accountLockedReason: 1, recentVideoClaims: 1 } });
    if (!userCheck) return res.status(404).json({ ok: false, error: 'user_not_found' });
    if (userCheck.isBanned) return res.status(403).json({ ok: false, error: 'banned' });
    // anti-script guard for the video section (lib/botGuard.js, rules V1/V2).
    if (userCheck.accountLocked && userCheck.accountLockedReason === 'bot_pattern') {
        return res.status(403).json({ ok: false, error: 'account_locked' });
    }
    const videoSample = { s: Number(startTime), c: Date.now(), a: award };
    const videoHit = detectVideoBotPattern([...(userCheck.recentVideoClaims || []), videoSample]);
    if (videoHit) {
        // V1/V2 detect things a real person cannot do (overlapping sessions) → always lock
        await lockForBotPattern(db, userId, videoHit, tgSend, 'Section: video', { forceLock: true });
        return res.status(403).json({ ok: false, error: 'account_locked' });
    }
    if (award > DAILY_VIDEO_WTC_MAX) return res.status(400).json({ ok: false, error: 'amount_exceeds_daily_cap' });

    // once the pending lootbox has reached the claimable minimum, stop
    // crediting further video WTC until the user actually claims it. Otherwise
    // WTC just keeps silently piling up in pendingVideoWTC (we've seen users
    // sit on 60+ WTC unclaimed) — this forces a claim (and its ad) before more
    // can accumulate, which is also what nudges the "please claim" UI below.
    if ((userCheck.pendingVideoWTC || 0) >= LOOTBOX_CLAIM_MIN) {
        return res.status(400).json({ ok: false, error: 'lootbox_claim_required' });
    }

    const startTimeKey = String(startTime);
    const gate = await users.findOneAndUpdate(
        {
            _id: userId,
            dailyVideoWtcMined: { $lt: DAILY_VIDEO_WTC_MAX },
            usedVideoStarts: { $ne: startTimeKey }, // ⚠️ this exact session hasn't been claimed yet today
        },
        [
            { $set: { _newDailyMined: { $min: [DAILY_VIDEO_WTC_MAX, { $add: ['$dailyVideoWtcMined', award] }] } } },
            { $set: {
                pendingVideoWTC: { $add: ['$pendingVideoWTC', { $subtract: ['$_newDailyMined', '$dailyVideoWtcMined'] }] },
                dailyVideoWtcMined: '$_newDailyMined',
                // ⚠️ $setUnion here acts like $addToSet inside an aggregation-pipeline
                // update — atomically records this startTime as spent, in the SAME
                // operation that grants the reward, so there's no race window between
                // "check if used" and "mark as used".
                usedVideoStarts: { $setUnion: [{ $ifNull: ['$usedVideoStarts', []] }, [startTimeKey]] },
                recentVideoClaims: { $slice: [{ $concatArrays: [{ $ifNull: ['$recentVideoClaims', []] }, [videoSample]] }, -VIDEO_CLAIM_HISTORY_KEEP] }, // ⚠️ NEW — feeds lib/botGuard.js
            } },
            { $unset: '_newDailyMined' },
        ],
        { returnDocument: 'after' }
    );
    if (!gate) {
        // Distinguish "already claimed this exact session" from "daily cap reached" for a clearer client error.
        const already = await users.findOne({ _id: userId, usedVideoStarts: startTimeKey }, { projection: { _id: 1 } });
        return res.status(400).json({ ok: false, error: already ? 'session_already_claimed' : 'daily_watch_limit_reached' });
    }

    return res.status(200).json({ ok: true, success: true, pendingVideoWTC: gate.pendingVideoWTC || 0, dailyVideoWtcMined: gate.dailyVideoWtcMined });
}


// ══════════════════════════════════════════════════════════════
// 🎮 GAMES (NEW) — play 2 min -> claim 5..15 WTC, max 40 claims/day
// Two signed, single-use tokens (both HMAC, both expire):
//   gameStart   -> play token   (must be >= GAME_PLAY_SECONDS old at claim)
//   gameAdStart -> ad token     (must be >= 6s old at claim = an ad actually ran)
// The reward amount is chosen by the SERVER (client cannot pick it).
// ══════════════════════════════════════════════════════════════
const signGame   = (userId, t) => crypto.createHmac('sha256', SECRET).update(`game:${userId}:${t}`).digest('hex');
const signGameAd = (userId, t) => crypto.createHmac('sha256', SECRET).update(`gamead:${userId}:${t}`).digest('hex');
const GAME_TOKEN_MAX_AGE_SEC = 3600;
const GAME_AD_MIN_SEC = 6;
const GAME_PLAY_TOLERANCE_SEC = 5; // small slack for network jitter

async function handleGameStart(req, res, db, userId) {
    if (!SECRET) return res.status(500).json({ ok: false, error: 'server_misconfigured' });
    const startTime = Date.now();
    return res.status(200).json({ ok: true, startTime, signature: signGame(userId, startTime) });
}
async function handleGameAdStart(req, res, db, userId) {
    if (!SECRET) return res.status(500).json({ ok: false, error: 'server_misconfigured' });
    const startTime = Date.now();
    return res.status(200).json({ ok: true, startTime, signature: signGameAd(userId, startTime) });
}
async function handleGameClaim(req, res, db, userId) {
    const { startTime, signature, adStartTime, adSignature } = req.body;
    if (!SECRET) return res.status(500).json({ ok: false, error: 'server_misconfigured' });
    if (!startTime || !signature || !adStartTime || !adSignature) return res.status(400).json({ ok: false, error: 'missing_ad_token' });
    if (signGame(userId, startTime) !== signature || signGameAd(userId, adStartTime) !== adSignature) {
        return res.status(400).json({ ok: false, error: 'invalid_ad_token' });
    }
    const now = Date.now();
    const playSec = (now - Number(startTime)) / 1000;
    const adSec = (now - Number(adStartTime)) / 1000;
    if (isNaN(playSec) || isNaN(adSec) || playSec < 0 || adSec < 0) return res.status(400).json({ ok: false, error: 'invalid_ad_token' });
    if (playSec < GAME_PLAY_SECONDS - GAME_PLAY_TOLERANCE_SEC) return res.status(400).json({ ok: false, error: 'game_play_too_short' });
    if (playSec > GAME_TOKEN_MAX_AGE_SEC || adSec > 300) return res.status(400).json({ ok: false, error: 'ad_token_expired' });
    if (adSec < GAME_AD_MIN_SEC) return res.status(400).json({ ok: false, error: 'watch_time_too_short' });

    const users = db.collection('users');
    await ensureDailyReset(users, userId);

    const reward = GAME_CLAIM_MIN + Math.floor(Math.random() * (GAME_CLAIM_MAX - GAME_CLAIM_MIN + 1));
    const k1 = String(startTime), k2 = String(adStartTime);
    const keep100 = (field, key) => ({ $slice: [{ $concatArrays: [{ $ifNull: [`$${field}`, []] }, [key]] }, -100] });
    // 🛡️ NEW — same shared cross-system cooldown as claimAdReward/claimLootbox (see note there).
    const cooldownCutoff = new Date(Date.now() - AD_COOLDOWN_SECONDS * 1000);

    const gate = await users.findOneAndUpdate(
        {
            _id: userId,
            isBanned: { $ne: true },
            usedGameStarts: { $ne: k1 },
            usedGameAdStarts: { $ne: k2 },
            $expr: { $lt: [{ $ifNull: ['$gameClaimsToday', 0] }, GAME_DAILY_CLAIMS_MAX] },
            $and: [
                { $or: [{ lastAdClaimAt: { $exists: false } }, { lastAdClaimAt: { $lte: cooldownCutoff } }] },
                REWARD_ELIGIBLE_FILTER,
            ],
        },
        [
            { $set: {
                wtcBalance: { $add: [{ $ifNull: ['$wtcBalance', 0] }, reward] },
                lifetimeWtcEarned: { $add: [{ $ifNull: ['$lifetimeWtcEarned', 0] }, reward] },
                gameClaimsToday: { $add: [{ $ifNull: ['$gameClaimsToday', 0] }, 1] },
                lifetimeGameClaims: { $add: [{ $ifNull: ['$lifetimeGameClaims', 0] }, 1] },
                usedGameStarts: keep100('usedGameStarts', k1),
                usedGameAdStarts: keep100('usedGameAdStarts', k2),
                lastAdClaimAt: new Date(), // 🛡️ NEW — feeds the shared cross-system cooldown
            } },
        ],
        { returnDocument: 'after' }
    );

    if (!gate) {
        const u = await users.findOne({ _id: userId }, { projection: { isBanned: 1, multiAccountFlag: 1, channelVerified: 1, gameClaimsToday: 1, usedGameStarts: 1, usedGameAdStarts: 1, lastAdClaimAt: 1 } });
        if (!u) return res.status(404).json({ ok: false, error: 'user_not_found' });
        if (u.isBanned) return res.status(403).json({ ok: false, error: 'banned' });
        if ((u.usedGameStarts || []).includes(k1) || (u.usedGameAdStarts || []).includes(k2)) return res.status(400).json({ ok: false, error: 'ad_token_already_used' });
        if ((u.gameClaimsToday || 0) >= GAME_DAILY_CLAIMS_MAX) return res.status(400).json({ ok: false, error: 'game_daily_limit' });
        if (u.multiAccountFlag && !u.channelVerified) return res.status(403).json({ ok: false, error: 'account_under_review' });
        if (u.lastAdClaimAt && u.lastAdClaimAt > cooldownCutoff) {
            return res.status(400).json({ ok: false, error: 'ad_cooldown', retryAfterMs: u.lastAdClaimAt.getTime() + AD_COOLDOWN_SECONDS * 1000 - Date.now() });
        }
        return res.status(400).json({ ok: false, error: 'game_claim_failed' });
    }
    return res.status(200).json({ ok: true, reward, gameClaimsToday: gate.gameClaimsToday });
}

// ══════════════════════════════════════════════════════════════
// 🔥 STREAK (NEW) — daily login bonus, 7-day cycle (STREAK_REWARDS in
// lib/constants.js: 10→20→35→55→80→120→200 WTC), one Adsgram "init" ad
// (STREAK_AD_MIN_SECONDS = 8s) per claim, once per Bangladesh calendar day.
// Claiming today when yesterday (BD) was the last claim advances the
// streak by one day (wrapping 7→1); any bigger gap resets to day 1.
// Shares the same lastAdClaimAt cross-system cooldown as every other
// ad-gated reward (see the note on claimAdReward below).
// ══════════════════════════════════════════════════════════════
const signStreak = (userId, t) => crypto.createHmac('sha256', SECRET).update(`streak:${userId}:${t}`).digest('hex');

async function handleStreakStart(req, res, db, userId) {
    if (!SECRET) return res.status(500).json({ ok: false, error: 'server_misconfigured' });
    const startTime = Date.now();
    return res.status(200).json({ ok: true, startTime, signature: signStreak(userId, startTime) });
}

async function handleStreakClaim(req, res, db, userId) {
    const { startTime, signature } = req.body;
    if (!SECRET) return res.status(500).json({ ok: false, error: 'server_misconfigured' });
    if (!startTime || !signature) return res.status(400).json({ ok: false, error: 'missing_ad_token' });
    if (signStreak(userId, startTime) !== signature) return res.status(400).json({ ok: false, error: 'invalid_ad_token' });
    const elapsedSeconds = (Date.now() - Number(startTime)) / 1000;
    if (isNaN(elapsedSeconds) || elapsedSeconds < 0) return res.status(400).json({ ok: false, error: 'invalid_ad_token' });
    if (elapsedSeconds < STREAK_AD_MIN_SECONDS) return res.status(400).json({ ok: false, error: 'watch_time_too_short' });
    if (elapsedSeconds > 300) return res.status(400).json({ ok: false, error: 'ad_token_expired' });

    const users = db.collection('users');
    const user = await users.findOne({ _id: userId }, { projection: { isBanned: 1, multiAccountFlag: 1, channelVerified: 1, streakCount: 1, streakLastClaimDate: 1, lastAdClaimAt: 1, usedStreakStarts: 1 } });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
    if (user.isBanned) return res.status(403).json({ ok: false, error: 'banned' });
    if (user.multiAccountFlag && !user.channelVerified) return res.status(403).json({ ok: false, error: 'account_under_review' });

    const streakStartKey = String(startTime);
    if ((user.usedStreakStarts || []).includes(streakStartKey)) return res.status(400).json({ ok: false, error: 'ad_token_already_used' });

    const cooldownCutoff = new Date(Date.now() - AD_COOLDOWN_SECONDS * 1000);
    if (user.lastAdClaimAt && user.lastAdClaimAt > cooldownCutoff) {
        return res.status(400).json({ ok: false, error: 'ad_cooldown', retryAfterMs: user.lastAdClaimAt.getTime() + AD_COOLDOWN_SECONDS * 1000 - Date.now() });
    }

    const todayStart = todayStartBD();
    const lastClaimStart = user.streakLastClaimDate ? new Date(user.streakLastClaimDate) : null;
    if (lastClaimStart && lastClaimStart.getTime() === todayStart.getTime()) {
        return res.status(400).json({ ok: false, error: 'streak_already_claimed_today' });
    }
    const isConsecutiveDay = lastClaimStart && (todayStart.getTime() - lastClaimStart.getTime()) === 86400000;
    const newDay = isConsecutiveDay ? ((user.streakCount || 0) >= 7 ? 1 : (user.streakCount || 0) + 1) : 1;
    const reward = STREAK_REWARDS[newDay - 1];

    // Optimistic-concurrency guard: the filter re-checks streakLastClaimDate
    // still matches what we just read, so two near-simultaneous claims
    // (e.g. a double-tap) can't both succeed off the same stale read.
    const prevDateFilter = user.streakLastClaimDate ? { streakLastClaimDate: user.streakLastClaimDate } : { streakLastClaimDate: { $exists: false } };
    const gate = await users.findOneAndUpdate(
        {
            _id: userId,
            isBanned: { $ne: true },
            usedStreakStarts: { $ne: streakStartKey },
            ...prevDateFilter,
            $and: [
                { $or: [{ lastAdClaimAt: { $exists: false } }, { lastAdClaimAt: { $lte: cooldownCutoff } }] },
                REWARD_ELIGIBLE_FILTER,
            ],
        },
        {
            $set: { streakCount: newDay, streakLastClaimDate: todayStart, lastAdClaimAt: new Date() },
            $inc: { wtcBalance: reward, lifetimeWtcEarned: reward },
            $push: { usedStreakStarts: { $each: [streakStartKey], $slice: -100 } },
        },
        { returnDocument: 'after' }
    );

    if (!gate) {
        // Lost a race (or something changed between the read above and now) — ask the client to retry.
        return res.status(409).json({ ok: false, error: 'streak_claim_conflict' });
    }
    return res.status(200).json({ ok: true, reward, streakDay: newDay });
}

// ── lootboxAdStart ── ⚠️ NEW (security fix) — issues a short-lived signed
// token the instant the user taps the lootbox, BEFORE the ad SDK is called.
// Mirrors adStart exactly — no DB write, just a signature the client must
// carry through the real ad and hand back to claimLootbox.
async function handleLootboxAdStart(req, res, db, userId) {
    if (!SECRET) return res.status(500).json({ ok: false, error: 'server_misconfigured' });
    const startTime = Date.now();
    return res.status(200).json({ ok: true, startTime, signature: signLootboxStart(userId, startTime) });
}

// ── claimLootbox ── ⚠️ NOW GATED by REWARD_ELIGIBLE_FILTER — this is where
// pendingVideoWTC actually becomes real wtcBalance, so it's the correct
// choke point for the video-earning path.
// previously this trusted a bare client-sent
// `{ adWatched: true }` boolean with NO verification at all, meaning anyone
// could call this endpoint directly (Termux/DevTools) and skip the mandatory
// ad entirely — the pendingVideoWTC amount itself was already safe (earned
// through the properly-gated videoClaim flow), but the ad-watch requirement
// itself was pure theater, costing real ad revenue on every claim. Now this
// requires the same signed startTime/signature token pattern as
// claimAdReward: issued by lootboxAdStart right before the ad plays, must
// reflect at least AD_MIN_WATCH_SECONDS of real elapsed time, expires after
// 5 minutes, and is single-use (usedLootboxStarts, atomic).
async function handleClaimLootbox(req, res, db, userId) {
    const { startTime, signature } = req.body;
    if (!startTime || !signature) {
        return res.status(400).json({ ok: false, error: 'missing_ad_token' });
    }
    if (signLootboxStart(userId, startTime) !== signature) {
        return res.status(400).json({ ok: false, error: 'invalid_ad_token' });
    }
    const elapsedSeconds = (Date.now() - Number(startTime)) / 1000;
    if (isNaN(elapsedSeconds) || elapsedSeconds < 0) {
        return res.status(400).json({ ok: false, error: 'invalid_ad_token' });
    }
    if (elapsedSeconds < AD_MIN_WATCH_SECONDS) {
        return res.status(400).json({ ok: false, error: 'watch_time_too_short' });
    }
    if (elapsedSeconds > 300) {
        return res.status(400).json({ ok: false, error: 'ad_token_expired' });
    }

    const users = db.collection('users');
    const lootboxStartKey = String(startTime);
    // the lootbox claim is an ad watch: run the same ad bot rules (A/B/C).
    const lbDoc = await users.findOne({ _id: userId }, { projection: { accountLocked: 1, accountLockedReason: 1, recentAdClaims: 1 } });
    if (lbDoc?.accountLocked && lbDoc.accountLockedReason === 'bot_pattern') {
        return res.status(403).json({ ok: false, error: 'account_locked' });
    }
    const lbSample = { s: Number(startTime), c: Date.now(), w: Math.round(elapsedSeconds * 10) / 10 };
    const lbHit = detectBotPattern([...(lbDoc?.recentAdClaims || []), lbSample]);
    if (lbHit) {
        // only rejects when the account was really locked (🔴 Likely script);
        // otherwise the admin is just notified and the claim continues.
        const lbLocked = await lockForBotPattern(db, userId, lbHit, tgSend, 'Section: video lootbox', { samples: [...(lbDoc?.recentAdClaims || []), lbSample] });
        if (lbLocked) return res.status(403).json({ ok: false, error: 'account_locked' });
    }
    // 🛡️ NEW — cross-system anti-farming cooldown (see file header note on
    // "shared lastAdClaimAt" above claimAdReward). Every ad-gated reward
    // path — network ads, lootbox, games, streak — now shares the SAME
    // lastAdClaimAt/AD_COOLDOWN_SECONDS gate, so a script can't dodge the
    // pacing limit by round-robining between different claim endpoints
    // (e.g. a network ad claim immediately followed by a lootbox claim
    // immediately followed by a game claim, each individually "legal" but
    // collectively impossible for a human watching one ad at a time).
    const cooldownCutoff = new Date(Date.now() - AD_COOLDOWN_SECONDS * 1000);
    const gate = await users.findOneAndUpdate(
        {
            _id: userId,
            isBanned: { $ne: true },
            pendingVideoWTC: { $gte: LOOTBOX_CLAIM_MIN },
            usedLootboxStarts: { $ne: lootboxStartKey }, // ⚠️ single-use, same pattern as usedAdStarts
            $and: [
                { $or: [{ lastAdClaimAt: { $exists: false } }, { lastAdClaimAt: { $lte: cooldownCutoff } }] },
                REWARD_ELIGIBLE_FILTER,
            ],
        },
        [
            { $set: {
                wtcBalance: { $add: ['$wtcBalance', '$pendingVideoWTC'] },
                lifetimeWtcEarned: { $add: ['$lifetimeWtcEarned', '$pendingVideoWTC'] },
                // tracks lifetime lootbox claims so we can
                // tell whether THIS claim is the user's first ever (see
                // referral-milestone hook below). Kept separate from
                // usedLootboxStarts (which is single-use-token replay
                // protection, reset daily) — this counter is lifetime and
                // never reset.
                lootboxClaimCount: { $add: [{ $ifNull: ['$lootboxClaimCount', 0] }, 1] },
            } },
            { $set: {
                pendingVideoWTC: 0,
                usedLootboxStarts: { $setUnion: [{ $ifNull: ['$usedLootboxStarts', []] }, [lootboxStartKey]] },
                lastAdClaimAt: new Date(), // 🛡️ NEW — feeds the shared cross-system cooldown above
                recentAdClaims: { $slice: [{ $concatArrays: [{ $ifNull: ['$recentAdClaims', []] }, [lbSample]] }, -AD_CLAIM_HISTORY_KEEP] }, // ⚠️ NEW — feeds lib/botGuard.js
            } },
        ],
        { returnDocument: 'before' }
    );

    if (!gate) {
        const exists = await users.findOne({ _id: userId }, { projection: { isBanned: 1, multiAccountFlag: 1, channelVerified: 1, pendingVideoWTC: 1, usedLootboxStarts: 1, lastAdClaimAt: 1 } });
        if (!exists) return res.status(404).json({ ok: false, error: 'user_not_found' });
        if (exists.isBanned) return res.status(403).json({ ok: false, error: 'banned' });
        if ((exists.usedLootboxStarts || []).includes(lootboxStartKey)) {
            return res.status(400).json({ ok: false, error: 'ad_token_already_used' });
        }
        // distinguish "flagged & unverified" from a plain below-minimum case
        if (exists.multiAccountFlag && !exists.channelVerified) {
            return res.status(403).json({ ok: false, error: 'account_under_review' });
        }
        if (exists.lastAdClaimAt && exists.lastAdClaimAt > cooldownCutoff) {
            return res.status(400).json({ ok: false, error: 'ad_cooldown', retryAfterMs: exists.lastAdClaimAt.getTime() + AD_COOLDOWN_SECONDS * 1000 - Date.now() });
        }
        return res.status(400).json({ ok: false, error: 'below_minimum', message: `Minimum ${LOOTBOX_CLAIM_MIN} WTC required.` });
    }

    // awards the referrer's 4th milestone
    // (REFERRAL_REWARDS.step4_firstLootbox, lib/constants.js) the first time
    // THIS user ever successfully claims a lootbox. `gate` here is the
    // document from BEFORE this update (returnDocument: 'before'), so
    // !gate.lootboxClaimCount means this claim is their first ever.
    if (!gate.lootboxClaimCount) {
        await maybeAwardReferralMilestones(db, userId, { lootboxClaimed: true });
    }

    return res.status(200).json({ ok: true, pointsAdded: gate.pendingVideoWTC || 0 });
}

// ── adStart ── ⚠️ NEW — issues a short-lived signed token the instant the
// user taps "Watch" on an ad-network card, BEFORE the ad SDK is even called.
// No DB write, no reward — just a signature the client must carry through
// the real ad flow and hand back to claimAdReward. A script that skips
// straight to claimAdReward with no token (or a stale/forged one) is
// rejected outright.
async function handleAdStart(req, res, db, userId) {
    const { network } = req.body;
    const netConfig = AD_NETWORK_REWARDS[network];
    if (!netConfig) return res.status(400).json({ ok: false, error: 'invalid_network' });
    // networks marked enabled:false (e.g. "usl", pending approval)
    // are visible in the UI as "Coming Soon" but can't actually be started.
    if (netConfig.enabled === false) return res.status(400).json({ ok: false, error: 'coming_soon' });
    if (!SECRET) return res.status(500).json({ ok: false, error: 'server_misconfigured' });

    const startTime = Date.now();
    return res.status(200).json({ ok: true, startTime, signature: signAdStart(userId, network, startTime) });
}

// ── claimAdReward ── ⚠️ NOW GATED + TOKEN-VERIFIED (see file header for why)
const COUNTER_FIELD = {
    adsgramDaily: 'adsgramDailyCountToday',
    adsgramSpecial: 'adsgramSpecialCountToday', // ⚠️ NEW — re-added Special Ads network
    monetag: 'monetagCountToday', giga: 'gigaCountToday',
    usl: 'uslCountToday', // ⚠️ NEW — ready for when "usl" is enabled
    monetagPopup: 'monetagPopupCountToday', // ⚠️ NEW — Monetag Rewarded Popup format, separate from `monetag`
};
async function handleClaimAdReward(req, res, db, userId) {
    const { network, startTime, signature, viewMs } = req.body;
    const config = AD_NETWORK_REWARDS[network];
    if (!config) return res.status(400).json({ ok: false, error: 'invalid_network' });
    // mirrors handleAdStart's guard, in case a stale/forged token
    // is ever replayed against a network that's disabled ("usl", coming soon).
    if (config.enabled === false) return res.status(400).json({ ok: false, error: 'coming_soon' });

    // the token issued by adStart is now mandatory.
    if (!startTime || !signature) {
        return res.status(400).json({ ok: false, error: 'missing_ad_token' });
    }
    if (signAdStart(userId, network, startTime) !== signature) {
        return res.status(400).json({ ok: false, error: 'invalid_ad_token' });
    }
    const elapsedSeconds = (Date.now() - Number(startTime)) / 1000;
    if (isNaN(elapsedSeconds) || elapsedSeconds < 0) {
        return res.status(400).json({ ok: false, error: 'invalid_ad_token' });
    }
    // was the shared AD_MIN_WATCH_SECONDS floor for every
    // network. Now uses THIS network's own minWatchSeconds (see
    // AD_NETWORK_REWARDS in lib/constants.js), falling back to the shared
    // constant for any network that doesn't set one. Must have taken at
    // least that many seconds since the token was issued — a genuine ad SDK
    // flow always takes real wall-clock time (loading + showing the ad); an
    // instant claim right after adStart means no ad was actually shown.
    const minWatchSeconds = config.minWatchSeconds ?? AD_MIN_WATCH_SECONDS;
    if (elapsedSeconds < minWatchSeconds) {
        return res.status(400).json({ ok: false, error: 'watch_time_too_short' });
    }
    // real ad-on-screen time, measured by the client from
    // "ad shown" to "ad finished/closed". Must be >= this network's
    // minWatchSeconds (closing earlier = no reward) and can't exceed the whole
    // adStart→claim time (it is a part of it). Missing/invalid value = rejected.
    const viewSeconds = Number(viewMs) / 1000;
    if (!Number.isFinite(viewSeconds) || viewSeconds < 0) {
        return res.status(400).json({ ok: false, error: 'missing_view_time' });
    }
    if (viewSeconds < minWatchSeconds) {
        return res.status(400).json({ ok: false, error: 'watch_time_too_short' });
    }
    if (viewSeconds > elapsedSeconds + AD_VIEW_TOLERANCE_SECONDS) {
        return res.status(400).json({ ok: false, error: 'invalid_view_time' });
    }
    // ⚠️ Token also expires after 5 minutes — prevents a script from
    // stockpiling many pre-signed tokens ahead of time and burning through
    // them later in a burst.
    if (elapsedSeconds > 300) {
        return res.status(400).json({ ok: false, error: 'ad_token_expired' });
    }

    const users = db.collection('users');
    const counterField = COUNTER_FIELD[network];
    await ensureDailyReset(users, userId);

    // anti-script guard (see lib/botGuard.js). Accounts already
    // locked for a bot pattern earn nothing more; otherwise the last few ad
    // claims + this one are checked for mechanical timing (no gap, ultra-fast,
    // identical cycles). A hit locks the account, alerts the admin, and rejects
    // this claim without paying.
    const guardDoc = await users.findOne({ _id: userId }, { projection: { accountLocked: 1, accountLockedReason: 1, recentAdClaims: 1 } });
    if (guardDoc?.accountLocked && guardDoc.accountLockedReason === 'bot_pattern') {
        return res.status(403).json({ ok: false, error: 'account_locked' });
    }
    const nowMs = Date.now();
    const adSample = { s: Number(startTime), c: nowMs, w: Math.round(elapsedSeconds * 10) / 10, v: Math.round(viewSeconds * 10) / 10 }; // w = tap→claim (server-measured, incl. loading), v = ad on screen (client-reported)
    const botHit = detectBotPattern([...(guardDoc?.recentAdClaims || []), adSample]);
    if (botHit) {
        // only rejects when the account was really locked (🔴 Likely script);
        // otherwise the admin is just notified and the claim continues.
        const adLocked = await lockForBotPattern(db, userId, botHit, tgSend, `Network: ${network}`, { samples: [...(guardDoc?.recentAdClaims || []), adSample] });
        if (adLocked) return res.status(403).json({ ok: false, error: 'account_locked' });
    }

    // AD_COOLDOWN_SECONDS was defined in constants.js but never
    // actually enforced anywhere. Wired in here: reject if the user's last
    // successful ad claim (any network) was less than AD_COOLDOWN_SECONDS
    // ago, so a script can't fire adStart→claimAdReward back-to-back with
    // zero pacing between ads.
    const cooldownCutoff = new Date(Date.now() - AD_COOLDOWN_SECONDS * 1000);

    // the token itself is single-use: `${network}:${startTime}` is
    // atomically checked-and-recorded in `usedAdStarts` in the very same
    // update that credits the reward, mirroring usedVideoStarts. Replaying
    // the exact same token twice earns nothing the second time.
    const adStartKey = `${network}:${startTime}`;
    const gate = await users.findOneAndUpdate(
        {
            _id: userId,
            isBanned: { $ne: true },
            [counterField]: { $lt: config.dailyLimit },
            usedAdStarts: { $ne: adStartKey },
            // the cooldown `$or` used to sit next to `...REWARD_ELIGIBLE_FILTER`,
            // which ALSO has a top-level `$or`. In a JS object the later key wins, so the
            // cooldown check was silently thrown away. Both conditions now live in `$and`.
            $and: [
                { $or: [{ lastAdClaimAt: { $exists: false } }, { lastAdClaimAt: { $lte: cooldownCutoff } }] },
                REWARD_ELIGIBLE_FILTER,
            ],
        },
        {
            $inc: { wtcBalance: config.reward, lifetimeWtcEarned: config.reward, lifetimeAdsWatched: 1, adsWatchedToday: 1, [counterField]: 1 },
            $addToSet: { usedAdStarts: adStartKey },
            $set: { lastAdClaimAt: new Date() },
            $push: { recentAdClaims: { $each: [adSample], $slice: -AD_CLAIM_HISTORY_KEEP } }, // ⚠️ NEW — feeds lib/botGuard.js
        },
        { returnDocument: 'after' }
    );

    if (!gate) {
        const exists = await users.findOne({ _id: userId }, { projection: { isBanned: 1, multiAccountFlag: 1, channelVerified: 1, usedAdStarts: 1, lastAdClaimAt: 1 } });
        if (!exists) return res.status(404).json({ ok: false, error: 'user_not_found' });
        if (exists.isBanned) return res.status(403).json({ ok: false, error: 'banned' });
        if ((exists.usedAdStarts || []).includes(adStartKey)) {
            return res.status(400).json({ ok: false, error: 'ad_token_already_used' });
        }
        if (exists.multiAccountFlag && !exists.channelVerified) {
            return res.status(403).json({ ok: false, error: 'account_under_review' });
        }
        if (exists.lastAdClaimAt && exists.lastAdClaimAt > cooldownCutoff) {
            return res.status(400).json({ ok: false, error: 'ad_cooldown', retryAfterMs: exists.lastAdClaimAt.getTime() + AD_COOLDOWN_SECONDS * 1000 - Date.now() });
        }
        return res.status(400).json({ ok: false, error: 'daily_limit_reached' });
    }

    await maybeAwardReferralMilestones(db, userId, { lifetimeAdsWatched: gate.lifetimeAdsWatched });
    return res.status(200).json({ ok: true, reward: config.reward, countToday: gate[counterField], dailyLimit: config.dailyLimit });
}

// ── spin ── ⚠️ NEW — Spin Wheel. Watching an ad (client picks randomly from
// usl/giga/adsgramDaily, per the admin's spec) is the "cost" of a spin turn.
// now backed by a real signed token (spinStart/signSpinStart),
// same as every other ad-gated reward, instead of pure client-side trust.
// Spends a bonus (referral) spin first if one's available, otherwise the
// free spin (subject to SPIN_FREE_COOLDOWN_HOURS); the reward itself is
// picked from SPIN_SEGMENTS by weight. Both pool-checks are separate atomic
// findOneAndUpdate calls so a double-tap can't double-spend either pool.
function rollSpinReward() {
    const total = SPIN_SEGMENTS.reduce((sum, s) => sum + s.weight, 0);
    let roll = Math.random() * total;
    for (let i = 0; i < SPIN_SEGMENTS.length; i++) {
        roll -= SPIN_SEGMENTS[i].weight;
        if (roll <= 0) return { value: SPIN_SEGMENTS[i].value, segmentIndex: i };
    }
    return { value: SPIN_SEGMENTS[0].value, segmentIndex: 0 }; // float-rounding fallback, practically unreachable
}
// ── spinStart ── ⚠️ NEW (this update) — issues a short-lived signed token
// the instant the user taps "Watch ad & Spin", before the ad SDK is even
// called. Mirrors handleAdStart exactly — no DB write, no reward, just a
// signature the client must carry through the real ad flow and hand back
// to `spin`. See the security-fix note on SPIN_FREE_COOLDOWN_HOURS in
// lib/constants.js for why this needed adding.
// records a REJECTED spin attempt (user tried before the 2h gap / with no spin left).
// Best-effort, never throws. If the same user is rejected SPIN_BLOCK_ALERT_COUNT times within
// SPIN_BLOCK_ALERT_WINDOW_MS, the admin gets ONE alert per user per day (Termux/script pattern).
// Blocked entries live in the same `spinLogs` collection (blocked:true) so the 30-day TTL cleans them too.
async function logBlockedSpin(db, userId, reason) {
    try {
        const logs = db.collection('spinLogs');
        await logs.insertOne({ userId: String(userId), blocked: true, reason, createdAt: new Date() });
        const since = new Date(Date.now() - SPIN_BLOCK_ALERT_WINDOW_MS);
        const n = await logs.countDocuments({ userId: String(userId), blocked: true, createdAt: { $gte: since } });
        const adminId = process.env.ADMIN_TELEGRAM_ID;
        if (n >= SPIN_BLOCK_ALERT_COUNT && adminId) {
            const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
            const flagged = await db.collection('users').findOneAndUpdate(
                { _id: userId, $or: [{ spinBlockAlertedAt: { $exists: false } }, { spinBlockAlertedAt: { $lte: dayAgo } }] },
                { $set: { spinBlockAlertedAt: new Date() } }
            );
            if (flagged) {
                tgSend(adminId,
                    `🛑 <b>Spin 2h-limit hammering</b>\n\nUser <code>${userId}</code> tried to spin <b>${n}</b> times in the last hour while still on cooldown (all blocked by the server, no WTC given). Likely a script/Termux.`,
                    { reply_markup: { inline_keyboard: [[{ text: '🔎 Review this account', callback_data: `lookup_${userId}` }]] } }
                ).catch(() => {});
            }
        }
    } catch (e) { /* best-effort */ }
}
async function handleSpinStart(req, res, db, userId) {
    // refuse before the ad if the user spun less than SPIN_MIN_GAP_SECONDS ago
    // (so an honest user never watches an ad for a spin that would be rejected).
    const last = await db.collection('users').findOne({ _id: userId }, { projection: { lastSpinAt: 1 } });
    if (last?.lastSpinAt) {
        const wait = new Date(last.lastSpinAt).getTime() + SPIN_MIN_GAP_SECONDS * 1000 - Date.now();
        if (wait > 0) { await logBlockedSpin(db, userId, 'start_too_fast'); return res.status(400).json({ ok: false, error: 'spin_too_fast', retryAfterMs: wait }); }
    }
    const startTime = Date.now();
    return res.status(200).json({ ok: true, startTime, signature: signSpinStart(userId, startTime) });
}
async function handleSpin(req, res, db, userId) {
    const { startTime, signature } = req.body;
    if (!startTime || !signature) {
        return res.status(400).json({ ok: false, error: 'missing_ad_token' });
    }
    if (signSpinStart(userId, startTime) !== signature) {
        return res.status(400).json({ ok: false, error: 'invalid_ad_token' });
    }
    const elapsedSeconds = (Date.now() - Number(startTime)) / 1000;
    if (isNaN(elapsedSeconds) || elapsedSeconds < 0) {
        return res.status(400).json({ ok: false, error: 'invalid_ad_token' });
    }
    if (elapsedSeconds < AD_MIN_WATCH_SECONDS) {
        return res.status(400).json({ ok: false, error: 'watch_time_too_short' });
    }
    if (elapsedSeconds > 300) {
        return res.status(400).json({ ok: false, error: 'ad_token_expired' });
    }

    const users = db.collection('users');
    await ensureDailyReset(users, userId);
    const spinStartKey = String(startTime); // single-use, same pattern as usedAdStarts/usedTaskStarts
    const nowMs = Date.now();
    const gapCutoff = new Date(nowMs - SPIN_MIN_GAP_SECONDS * 1000);
    // minimum gap between ANY two spins, enforced atomically inside the same update
    const gapOk = { $or: [{ lastSpinAt: { $exists: false } }, { lastSpinAt: { $lte: gapCutoff } }] };

    // Bonus (referral) spins are tried first, same priority as before —
    // but capped at BONUS_SPINS_MAX_PER_DAY per day (leftovers carry over to tomorrow).
    let gate = await users.findOneAndUpdate(
        {
            _id: userId, isBanned: { $ne: true }, bonusSpinsAvailable: { $gt: 0 }, usedSpinStarts: { $ne: spinStartKey },
            $and: [
                gapOk,
                { $or: [{ bonusSpinsUsedToday: { $exists: false } }, { bonusSpinsUsedToday: { $lt: BONUS_SPINS_MAX_PER_DAY } }] },
                REWARD_ELIGIBLE_FILTER,
            ],
        },
        { $inc: { bonusSpinsAvailable: -1, bonusSpinsUsedToday: 1 }, $set: { lastSpinAt: new Date() }, $addToSet: { usedSpinStarts: spinStartKey } },
        { returnDocument: 'after' }
    );
    const usedBonus = !!gate;
    if (!gate) {
        // Free spin: one every SPIN_FREE_COOLDOWN_HOURS.
        // this cooldown was NOT actually being enforced.
        // The `$or` for lastFreeSpinAt sat in the same object as `...REWARD_ELIGIBLE_FILTER`
        // (which has its own top-level `$or`), and the later key silently replaced the
        // earlier one — so the 2-hour check was dropped and a script could take a free
        // spin every ~20 seconds. Both conditions are now inside `$and`.
        const cooldownCutoff = new Date(nowMs - SPIN_FREE_COOLDOWN_HOURS * 60 * 60 * 1000);
        gate = await users.findOneAndUpdate(
            {
                _id: userId, isBanned: { $ne: true }, usedSpinStarts: { $ne: spinStartKey },
                $and: [
                    gapOk,
                    { $or: [{ lastFreeSpinAt: { $exists: false } }, { lastFreeSpinAt: { $lte: cooldownCutoff } }] },
                    REWARD_ELIGIBLE_FILTER,
                ],
            },
            { $set: { lastFreeSpinAt: new Date(), lastSpinAt: new Date() }, $addToSet: { usedSpinStarts: spinStartKey } },
            { returnDocument: 'after' }
        );
    }

    if (!gate) {
        const exists = await users.findOne({ _id: userId }, { projection: { isBanned: 1, multiAccountFlag: 1, channelVerified: 1, lastFreeSpinAt: 1, lastSpinAt: 1, usedSpinStarts: 1, bonusSpinsAvailable: 1, bonusSpinsUsedToday: 1 } });
        if (!exists) return res.status(404).json({ ok: false, error: 'user_not_found' });
        if (exists.isBanned) return res.status(403).json({ ok: false, error: 'banned' });
        if ((exists.usedSpinStarts || []).includes(spinStartKey)) {
            return res.status(400).json({ ok: false, error: 'ad_token_already_used' });
        }
        if (exists.multiAccountFlag && !exists.channelVerified) return res.status(403).json({ ok: false, error: 'account_under_review' });
        const gapWait = exists.lastSpinAt ? new Date(exists.lastSpinAt).getTime() + SPIN_MIN_GAP_SECONDS * 1000 - Date.now() : 0;
        if (gapWait > 0) { await logBlockedSpin(db, userId, 'spin_too_fast'); return res.status(400).json({ ok: false, error: 'spin_too_fast', retryAfterMs: gapWait }); }
        const retryAfterMs = exists.lastFreeSpinAt
            ? Math.max(0, new Date(exists.lastFreeSpinAt).getTime() + SPIN_FREE_COOLDOWN_HOURS * 60 * 60 * 1000 - Date.now())
            : 0;
        if ((exists.bonusSpinsAvailable || 0) > 0 && (exists.bonusSpinsUsedToday || 0) >= BONUS_SPINS_MAX_PER_DAY && retryAfterMs > 0) {
            return res.status(400).json({ ok: false, error: 'bonus_spin_limit', retryAfterMs });
        }
        await logBlockedSpin(db, userId, 'no_spins_left');
        return res.status(400).json({ ok: false, error: 'no_spins_left', retryAfterMs });
    }

    const { value: reward, segmentIndex } = rollSpinReward();
    const credited = await users.findOneAndUpdate(
        { _id: userId },
        {
            $inc: { wtcBalance: reward, lifetimeWtcEarned: reward, spinsSinceWithdraw: 1, lifetimeSpins: 1 }, // ⚠️ NEW — spinsSinceWithdraw feeds the withdraw spin requirement; lifetimeSpins feeds referral step 5
            // last 8 spin timestamps, used only for the bot-pattern alert below (capped, tiny)
            $push: { recentSpinTimes: { $each: [Date.now()], $slice: -8 } },
        },
        { returnDocument: 'after' }
    );

    // referral step 5: referred user reached 20 lifetime spins → referrer gets +100 WTC (once).
    try { await maybeAwardReferralMilestones(db, userId, { lifetimeSpins: credited?.lifetimeSpins || 0 }); } catch (e) { /* never blocks the spin reward */ }

    // spin history record (admin sees the last 30 days in the user panel; TTL index auto-deletes older ones)
    try {
        await db.collection('spinLogs').insertOne({ userId: String(userId), reward, type: usedBonus ? 'bonus' : 'free', blocked: false, createdAt: new Date() });
    } catch (e) { /* history is best-effort — never blocks the reward */ }

    // bot-pattern alert. A person's spins are irregular (ad length, reading the
    // result, distractions). A script repeats almost the same gap every time. If the last
    // SPIN_BOT_MIN_SPINS spins were all close together AND nearly evenly spaced, tell the admin
    // once per user per day. Never blocks the spin; alert only. Best-effort — errors are ignored.
    try {
        const times = credited?.recentSpinTimes || [];
        if (times.length >= SPIN_BOT_MIN_SPINS) {
            const recent = times.slice(-SPIN_BOT_MIN_SPINS);
            const gaps = recent.slice(1).map((t, i) => t - recent[i]);
            const spread = Math.max(...gaps) - Math.min(...gaps);
            const botLike = Math.max(...gaps) <= SPIN_BOT_MAX_GAP_MS && spread <= SPIN_BOT_MAX_SPREAD_MS;
            const adminId = process.env.ADMIN_TELEGRAM_ID;
            if (botLike && adminId) {
                const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
                const flagged = await users.findOneAndUpdate(
                    { _id: userId, $or: [{ spinBotAlertedAt: { $exists: false } }, { spinBotAlertedAt: { $lte: dayAgo } }] },
                    { $set: { spinBotAlertedAt: new Date() } }
                );
                if (flagged) {
                    tgSend(
                        adminId,
                        `🤖 <b>Bot-like spin pattern</b>\n\nUser <code>${userId}</code> took ${SPIN_BOT_MIN_SPINS} spins with almost identical gaps (~${Math.round(gaps.reduce((x, y) => x + y, 0) / gaps.length / 1000)}s apart, spread ${Math.round(spread / 100) / 10}s). Looks like a script, not a person.`,
                        { reply_markup: { inline_keyboard: [[{ text: '🔎 Review this account', callback_data: `lookup_${userId}` }]] } }
                    ).catch(() => {});
                }
            }
        }
    } catch (e) { /* alert is best-effort */ }

    return res.status(200).json({
        ok: true,
        reward,
        segmentIndex,
        usedBonus,
        // replaces spinsLeftToday. Frontend computes the
        // countdown as lastFreeSpinAt + SPIN_FREE_COOLDOWN_HOURS.
        lastFreeSpinAt: credited?.lastFreeSpinAt ?? gate.lastFreeSpinAt ?? null,
        lastSpinAt: credited?.lastSpinAt ?? gate.lastSpinAt ?? null,
        bonusSpinsLeft: credited?.bonusSpinsAvailable ?? gate.bonusSpinsAvailable ?? 0,
    });
}

// ── taskComplete ── ⚠️ NOW GATED (STEP 2 only — see comment below on why STEP 1's slot-claim stays ungated)
// previously the task.limit check used a plain read
// (`task.completionCount >= task.limit`), and completionCount was incremented
// separately with an unconditional updateOne — leaving a race window between
// the two. If many users completed the same limited task at almost the exact
// same moment, they could all see "not full yet" and pass, letting
// completionCount overshoot the task's limit (low severity, but a real bug).
// Now claiming the task's "slot" is also atomic — the check+increment of the
// task's own completionCount+limit condition happens in the same
// findOneAndUpdate, and if crediting the user's record fails afterward (e.g.
// a double-click race, OR the new multi-account review gate), the slot is
// rolled back.
// ── taskStart ── ⚠️ NEW (security fix) — issues a short-lived signed token
// the instant the user taps "Start" on a task (before they even leave the
// app for the link). Mirrors adStart/lootboxAdStart exactly. Not required
// for 'channel' tasks — those are independently verified via real Telegram
// membership, which is already proof enough on its own.
async function handleTaskStart(req, res, db, userId) {
    const { taskId } = req.body;
    if (!taskId) return res.status(400).json({ ok: false, error: 'missing_fields' });
    if (!SECRET) return res.status(500).json({ ok: false, error: 'server_misconfigured' });
    const startTime = Date.now();
    return res.status(200).json({ ok: true, startTime, signature: signTaskStart(userId, taskId, startTime) });
}

// ── taskComplete ── ⚠️ NOW GATED (STEP 2 only — see comment below on why STEP 1's slot-claim stays ungated)
// previously the task.limit check used a plain read
// (`task.completionCount >= task.limit`), and completionCount was incremented
// separately with an unconditional updateOne — leaving a race window between
// the two. If many users completed the same limited task at almost the exact
// same moment, they could all see "not full yet" and pass, letting
// completionCount overshoot the task's limit (low severity, but a real bug).
// Now claiming the task's "slot" is also atomic — the check+increment of the
// task's own completionCount+limit condition happens in the same
// findOneAndUpdate, and if crediting the user's record fails afterward (e.g.
// a double-click race, OR the new multi-account review gate), the slot is
// rolled back.
//
// for every category EXCEPT 'channel', this
// used to credit the full reward the instant taskComplete was called, with
// ZERO proof the user ever opened the link/article/faucet — the frontend's
// 10-second "Claim in 10s..." countdown was pure UI, never enforced
// server-side. A script with a valid initData could loop every open taskId
// and instant-claim the full reward for each one, never visiting anything.
// Now (mirroring the ad/lootbox pattern) these categories require a signed
// taskStart token issued when the task sheet opens, and taskComplete
// verifies: (1) the signature is genuine and matches this exact taskId, (2)
// at least TASK_MIN_WAIT_SECONDS has passed since it was issued, (3) the
// token hasn't been spent already (usedTaskStarts, atomic, single-use). This
// doesn't prove the link was actually read — no server-side check can fully
// prove that for an external site — but it closes the "claim every task in
// under a second via direct API calls" hole, which is the actual exploit.
// 'channel' tasks are unaffected — Telegram membership is real proof and
// doesn't need this.
async function handleTaskComplete(req, res, db, userId) {
    const { taskId, startTime, signature } = req.body;
    if (!taskId) return res.status(400).json({ ok: false, error: 'missing_fields' });

    const users = db.collection('users');
    const tasks = db.collection('tasks');
    await ensureDailyReset(users, userId);

    const user = await users.findOne({ _id: userId });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
    if (user.isBanned) return res.status(403).json({ ok: false, error: 'banned' });
    if ((user.completedTasks || []).includes(taskId)) return res.status(200).json({ ok: false, alreadyDone: true });

    let taskObjId;
    try { taskObjId = new ObjectId(taskId); } catch { return res.status(400).json({ ok: false, error: 'invalid_task_id' }); }

    const task = await tasks.findOne({ _id: taskObjId });
    if (!task || !task.isApproved) return res.status(404).json({ ok: false, error: 'task_not_found' });

    let taskStartKey = null;
    // API-verified join tasks are no longer tied
    // to the 'channel' category only. Any category can now be marked
    // verifyType: 'api' from the admin panel (see api/bot.js task_verify_api).
    // Old tasks created before this field existed still work — they fall
    // back to the category check.
    const isApiVerified = task.verifyType === 'api' || (!task.verifyType && task.category === 'channel');
    if (isApiVerified) {
        const member = await isMember(userId, task.channelId);
        if (!member) return res.status(200).json({ ok: false, error: 'not_member' });
    } else {
        // ── non-channel categories now require a valid taskStart token ──
        if (!startTime || !signature) return res.status(400).json({ ok: false, error: 'missing_task_token' });
        if (signTaskStart(userId, taskId, startTime) !== signature) {
            return res.status(400).json({ ok: false, error: 'invalid_task_token' });
        }
        const elapsedSeconds = (Date.now() - Number(startTime)) / 1000;
        if (isNaN(elapsedSeconds) || elapsedSeconds < 0) {
            return res.status(400).json({ ok: false, error: 'invalid_task_token' });
        }
        if (elapsedSeconds < TASK_MIN_WAIT_SECONDS) {
            return res.status(400).json({ ok: false, error: 'claimed_too_fast' });
        }
        if (elapsedSeconds > 300) {
            return res.status(400).json({ ok: false, error: 'task_token_expired' });
        }
        if ((user.usedTaskStarts || []).includes(`${taskId}:${startTime}`)) {
            return res.status(400).json({ ok: false, error: 'task_token_already_used' });
        }
        // cross-task cooldown (see TASK_COOLDOWN_SECONDS in
        // lib/constants.js). A quick pre-check here just for a clean, fast
        // rejection before wasting a task "slot" claim below — the REAL
        // enforcement (closing the race window) is the atomic filter on
        // lastTaskClaimAt in the STEP 2 update further down.
        if (user.lastTaskClaimAt && new Date(user.lastTaskClaimAt).getTime() > Date.now() - TASK_COOLDOWN_SECONDS * 1000) {
            return res.status(400).json({
                ok: false, error: 'task_cooldown',
                retryAfterMs: new Date(user.lastTaskClaimAt).getTime() + TASK_COOLDOWN_SECONDS * 1000 - Date.now(),
            });
        }
        taskStartKey = `${taskId}:${startTime}`;
    }

    // ── STEP 1: atomically claim the task's "slot" (limit check + increment together) ──
    // ⚠️ Intentionally NOT gated by REWARD_ELIGIBLE_FILTER — this is a shared,
    // limited-quota resource across ALL users, not this user's own reward. A
    // flagged user's failed claim below correctly gives this slot back (see
    // STEP 2), so legit users' quota is never actually consumed by them.
    const taskGate = await tasks.findOneAndUpdate(
        { _id: taskObjId, $or: [{ limit: { $lte: 0 } }, { limit: { $exists: false } }, { $expr: { $lt: ['$completionCount', '$limit'] } }] },
        { $inc: { completionCount: 1 } },
        { returnDocument: 'after' }
    );
    if (!taskGate) return res.status(400).json({ ok: false, error: 'task_full' });

    const rewardWtc = task.rewardWtc || task.rewardGold || task.rewardPoints || 10; // default fallback if admin left it blank

    // ── STEP 2: atomically credit the user (a double-claim by the same user is caught right here) ──
    // also requires REWARD_ELIGIBLE_FILTER, and (for non-channel
    // categories) the taskStart token is atomically marked spent in the same
    // update that credits the reward — same single-use pattern as
    // usedAdStarts/usedVideoStarts.
    const gate = await users.findOneAndUpdate(
        {
            _id: userId,
            completedTasks: { $ne: taskId },
            ...(taskStartKey ? {
                usedTaskStarts: { $ne: taskStartKey },
                // atomic re-check of the cooldown pre-check above, closing
                // the race window (e.g. two rapid double-taps landing near the
                // boundary, or two different tasks' claims arriving milliseconds
                // apart). Only applies to non-channel tasks (taskStartKey set).
            } : {}),
            // same duplicate-`$or` problem as the ad claim above: the task
            // cooldown re-check was overwritten by REWARD_ELIGIBLE_FILTER's `$or`.
            $and: [
                ...(taskStartKey ? [{ $or: [{ lastTaskClaimAt: { $exists: false } }, { lastTaskClaimAt: { $lte: new Date(Date.now() - TASK_COOLDOWN_SECONDS * 1000) } }] }] : []),
                REWARD_ELIGIBLE_FILTER,
            ],
        },
        {
            $inc: { wtcBalance: rewardWtc, lifetimeWtcEarned: rewardWtc, tasksCompletedToday: 1 },
            $addToSet: taskStartKey ? { completedTasks: taskId, usedTaskStarts: taskStartKey } : { completedTasks: taskId },
            // only stamped for non-channel tasks; channel/api-verified
            // tasks aren't subject to the cooldown so there's no need to track it
            // for them (and no reason to make an unrelated 'channel' claim wait on
            // an earlier non-channel task's timer, or vice versa).
            ...(taskStartKey ? { $set: { lastTaskClaimAt: new Date() } } : {}),
        },
        { returnDocument: 'after' }
    );
    if (!gate) {
        // Crediting the user failed (e.g. already done in a race, OR blocked by
        // the multi-account review gate) — give the task's slot back either way.
        await tasks.updateOne({ _id: taskObjId }, { $inc: { completionCount: -1 } });
        const exists = await users.findOne({ _id: userId }, { projection: { completedTasks: 1, multiAccountFlag: 1, channelVerified: 1, usedTaskStarts: 1, lastTaskClaimAt: 1 } });
        if (taskStartKey && (exists?.usedTaskStarts || []).includes(taskStartKey)) {
            return res.status(400).json({ ok: false, error: 'task_token_already_used' });
        }
        // surface the cooldown specifically (instead of falling through
        // to the generic alreadyDone below) if that's what actually blocked it.
        if (taskStartKey && exists?.lastTaskClaimAt && new Date(exists.lastTaskClaimAt).getTime() > Date.now() - TASK_COOLDOWN_SECONDS * 1000) {
            return res.status(400).json({
                ok: false, error: 'task_cooldown',
                retryAfterMs: new Date(exists.lastTaskClaimAt).getTime() + TASK_COOLDOWN_SECONDS * 1000 - Date.now(),
            });
        }
        if (exists?.multiAccountFlag && !exists.channelVerified && !(exists.completedTasks || []).includes(taskId)) {
            return res.status(403).json({ ok: false, error: 'account_under_review' });
        }
        return res.status(200).json({ ok: false, alreadyDone: true });
    }

    await maybeAwardReferralMilestones(db, userId, { completedTasksCount: gate.completedTasks.length });

    // user-created tasks (see api/payments.js (resource:'taskcreate')) auto-delete
    // USER_TASK_COMPLETED_TTL_DAYS after they hit their completion limit
    // (TTL index in models/schema.js). Only fires for isUserCreated:true
    // tasks — an admin-set limit on a normal task is never auto-deleted
    // this way. Placed AFTER the reward-credit gate above succeeds (not
    // right after taskGate) so a completion that gets rolled back (STEP 2
    // failing, slot given back at line ~597) never wrongly marks the task
    // "completed" while its real completionCount is actually back below limit.
    if (taskGate.isUserCreated && taskGate.limit > 0 && taskGate.completionCount >= taskGate.limit) {
        tasks.updateOne({ _id: taskObjId, completedAt: { $exists: false } }, { $set: { completedAt: new Date() } }).catch(() => {});
    }

    return res.status(200).json({ ok: true, rewardWtc });
}

// ── checkPromo ── ⚠️ NEW — read-only pre-validation, called BEFORE the ad
// is shown (see redeemPromoCode() in index.html). Previously the ad played
// unconditionally, so an invalid/expired/already-used code still cost the
// user a full ad watch before they found out it failed. This mirrors every
// validation in handleClaimPromo below EXCEPT it never mutates the promo
// doc — the real, atomic redemption still happens in claimPromo after the
// ad, so a code that becomes invalid in the few seconds between the two
// calls (a genuine race, not a UX annoyance) is still safely caught there.
async function handleCheckPromo(req, res, db, userId) {
    const { code } = req.body;
    if (!code) return res.status(400).json({ ok: false, error: 'missing_fields' });

    const promos = db.collection('promos');
    const promo = await promos.findOne({ code: String(code).trim() });
    if (!promo) return res.status(404).json({ ok: false, error: 'invalid_code' });
    if (promo.expiresAt && new Date(promo.expiresAt) < new Date()) return res.status(400).json({ ok: false, error: 'expired' });
    if ((promo.redeemedBy || []).includes(userId)) return res.status(400).json({ ok: false, error: 'already_used' });
    const maxUses = promo.maxUses || 9999;
    if ((promo.usedCount || 0) >= maxUses) return res.status(400).json({ ok: false, error: 'fully_used' });

    const users = db.collection('users');
    const user = await users.findOne({ _id: userId });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
    if (user.isBanned) return res.status(403).json({ ok: false, error: 'banned' });

    return res.status(200).json({ ok: true });
}

// ── claimPromo ── ⚠️ NOW GATED
async function handleClaimPromo(req, res, db, userId) {
    const { code } = req.body;
    if (!code) return res.status(400).json({ ok: false, error: 'missing_fields' });

    const promos = db.collection('promos');
    const users = db.collection('users');

    const promo = await promos.findOne({ code: String(code).trim() });
    if (!promo) return res.status(404).json({ ok: false, error: 'invalid_code' });
    if (promo.expiresAt && new Date(promo.expiresAt) < new Date()) return res.status(400).json({ ok: false, error: 'expired' });

    const user = await users.findOne({ _id: userId });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
    if (user.isBanned) return res.status(403).json({ ok: false, error: 'banned' });

    const maxUses = promo.maxUses || 9999;
    const promoGate = await promos.findOneAndUpdate(
        { _id: promo._id, usedCount: { $lt: maxUses }, redeemedBy: { $ne: userId } },
        { $inc: { usedCount: 1 }, $addToSet: { redeemedBy: userId } },
        { returnDocument: 'after' }
    );
    if (!promoGate) {
        const fresh = await promos.findOne({ _id: promo._id });
        if ((fresh.redeemedBy || []).includes(userId)) return res.status(400).json({ ok: false, error: 'already_used' });
        return res.status(400).json({ ok: false, error: 'fully_used' });
    }

    // the promo code itself is already marked used above (promoGate)
    // even if the credit below is blocked by REWARD_ELIGIBLE_FILTER —
    // otherwise a flagged user could keep retrying the same code after
    // verifying, defeating the code's single-use-per-user limit. Trade-off:
    // a flagged user "burns" a promo code with zero reward if they redeem it
    // while still unverified. Accepted, since promo codes are typically
    // low-value and this closes an easy retry-abuse path.
    const reward = promo.reward || 0;
    const creditResult = await users.updateOne(
        { _id: userId, ...REWARD_ELIGIBLE_FILTER },
        { $inc: { wtcBalance: reward, lifetimeWtcEarned: reward } }
    );
    if (creditResult.matchedCount === 0) {
        return res.status(403).json({ ok: false, error: 'account_under_review' });
    }

    return res.status(200).json({ ok: true, reward });
}

// ⚠️ REMOVED (this update) — Monetag S2S postback system
// (handleMonetagPostback + the `?pb=monetag` GET route). Admin decision:
// reverted back to the ordinary signed-token + timer flow every other
// network uses (see AD_NETWORK_REWARDS in lib/constants.js — monetag and
// monetagPopup now both have a plain `minWatchSeconds: 6`). No more
// MONETAG_POSTBACK_SECRET, no more `monetagProcessedYmids` collection, no
// more per-user ymid generation in index.html.

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

    const { action } = req.body || {};

    // All actions require a valid Telegram session
    const verified = verifyTelegramInitData(req.body?.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const userId = String(verified.user.id);

    // videoStart used to be handled BEFORE the
    // initData check above, deliberately bypassing it, and signed whatever
    // `userId` the client sent in the request body with zero verification.
    // That meant a plain script (no Telegram session at all) could mint an
    // unlimited number of valid (startTime, signature) pairs for a
    // self-chosen userId — no ad SDK, no video element, no app even open —
    // then simply wait real wall-clock time and call videoClaim to fill
    // pendingVideoWTC. Every other reward-start endpoint here (adStart,
    // lootboxAdStart, taskStart) already required a verified session; this
    // one was the one gap. The client (apiPost, index.html) already sends
    // `initData` on every call including this one, so nothing on the
    // frontend needs to change — this just stops the server from ignoring
    // it for this specific action. The old justification ("prevents session
    // renewal failures when TG_INIT_DATA expires mid-session") doesn't hold
    // up: Telegram initData stays valid for 24h (see telegramAuth.js
    // MAX_AUTH_AGE_SECONDS), far longer than any realistic single video
    // session, let alone the 5-hour daily cap on watch time.
    if (action === 'videoStart') {
        if (!SECRET) return res.status(500).json({ success: false, error: 'video_secret_missing' });
        const startTime = Date.now();
        return res.status(200).json({ success: true, startTime, signature: sign(userId, startTime) });
    }

    const { db } = await connectToDatabase();

    // Terms & Conditions gate. No earning action of any
    // kind (video, ads, lootbox, spin, tasks, promo) is accepted until the
    // user has agreed to the current terms in the app (api/user.js
    // action:'acceptTerms'). One tiny projected read per request.
    const termsUser = await db.collection('users').findOne({ _id: userId }, { projection: { termsVersion: 1 } });
    if (termsUser && termsUser.termsVersion !== TERMS_VERSION) {
        return res.status(403).json({ ok: false, success: false, error: 'terms_required' });
    }

    switch (action) {
        case 'videoClaim':     return handleVideoClaim(req, res, db, userId);
        case 'gameStart':      return handleGameStart(req, res, db, userId);
        case 'gameAdStart':    return handleGameAdStart(req, res, db, userId);
        case 'gameClaim':      return handleGameClaim(req, res, db, userId);
        case 'streakStart':    return handleStreakStart(req, res, db, userId);
        case 'streakClaim':    return handleStreakClaim(req, res, db, userId);
        case 'lootboxAdStart': return handleLootboxAdStart(req, res, db, userId);
        case 'claimLootbox':   return handleClaimLootbox(req, res, db, userId);
        case 'adStart':        return handleAdStart(req, res, db, userId);
        case 'claimAdReward':  return handleClaimAdReward(req, res, db, userId);
        case 'spinStart':       return handleSpinStart(req, res, db, userId);
        case 'spin':            return handleSpin(req, res, db, userId);
        case 'taskStart':       return handleTaskStart(req, res, db, userId);
        case 'taskComplete':   return handleTaskComplete(req, res, db, userId);
        case 'checkPromo':      return handleCheckPromo(req, res, db, userId);
        case 'claimPromo':     return handleClaimPromo(req, res, db, userId);
        default: return res.status(400).json({ ok: false, error: 'unknown_action' });
    }
}
