// lib/dailyClaim.js — ⚡ Daily Claim (+20 … +140 VYRO COIN, 7-day path)
//
//   { action: 'dailyClaimStatus', initData }   → where the user is on the path (no side effects)
//   { action: 'dailyClaim',       initData }   → "Check & Claim": verifies the bio, then pays out
//
// Security model
//  • userId always comes from the verified initData (api/earn.js) — never from the body.
//  • The reward amount is decided ONLY here from the server-side state; the client sends nothing
//    that influences it, so the balance can't be manipulated from the browser.
//  • Verification = the user's OWN referral link (MINI_APP_BASE?startapp=<their id>) must appear in
//    their Telegram bio. A Mini App can't read a bio, so the BOT does it through the Bot API
//    (getChat on the user's private chat). That only works if the user has started the bot and the
//    bio is visible to "Everybody" — otherwise Telegram returns no bio and the claim is refused.
//  • Payout is ONE atomic findOneAndUpdate guarded by the previous claim date, so a double tap /
//    two parallel requests / replayed request can pay at most once per Bangladesh day.
//  • Same balance as everywhere else (users.wtcBalance + lifetimeWtcEarned) — no separate balance.
//    Every payout is also written to `dailyClaims` (history / transaction log, unique per user+day).

import { tgApi } from './telegram.js';
import { todayStartBD, DAILY_CLAIM_REWARDS, DAILY_CLAIM_MIN_GAP_MS, MINI_APP_BASE } from './constants.js';

const DAY_MS = 86400000;

export const referralLinkFor = (userId) => `${MINI_APP_BASE}?startapp=${userId}`;

// Does `bio` contain this user's referral link? Accepts https://, http:// or no scheme, any case,
// and refuses a longer id (…startapp=123 must not match …startapp=1234567).
export function bioHasReferralLink(bio, userId) {
    if (typeof bio !== 'string' || !bio) return false;
    const host = MINI_APP_BASE.replace(/^https?:\/\//i, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|[^a-z0-9_.])(?:https?:\\/\\/)?${host}\\/?\\?startapp=${String(userId).replace(/\D/g, '')}(?![0-9a-z_])`, 'i');
    return re.test(bio);
}

// Where is the user on the 7-day path right now?
export function computePath(user, todayStart = todayStartBD()) {
    const last = user?.dailyClaimLastDate ? new Date(user.dailyClaimLastDate).getTime() : null;
    const lastDay = Math.min(7, Math.max(0, Number(user?.dailyClaimDay) || 0));
    const claimedToday = last !== null && last === todayStart.getTime();
    const consecutive = last !== null && todayStart.getTime() - last === DAY_MS;
    // claimedToday → nothing left to claim, the path stays on today's day
    const nextDay = claimedToday ? lastDay : (consecutive ? (lastDay >= 7 ? 1 : lastDay + 1) : 1);
    return { claimedToday, lastDay, nextDay, reward: DAILY_CLAIM_REWARDS[nextDay - 1] };
}

const pathPayload = (user, userId) => {
    const p = computePath(user);
    return {
        claimedToday: p.claimedToday, currentDay: p.nextDay, nextReward: p.reward,
        rewards: DAILY_CLAIM_REWARDS, link: referralLinkFor(userId),
        totalClaims: user?.dailyClaimTotal || 0,
        verifyStatus: user?.dailyClaimVerifyStatus || null,
    };
};

export async function handleDailyClaimStatus(req, res, db, userId) {
    const user = await db.collection('users').findOne({ _id: userId }, {
        projection: { dailyClaimDay: 1, dailyClaimLastDate: 1, dailyClaimTotal: 1, dailyClaimVerifyStatus: 1 },
    });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
    return res.status(200).json({ ok: true, ...pathPayload(user, userId) });
}

// Reads the user's bio through the Bot API. → { status: 'ok'|'empty'|'missing_link'|'unavailable' }
async function checkBio(userId) {
    let r;
    try { r = await tgApi('getChat', { chat_id: userId }); }
    catch (e) { return { status: 'unavailable' }; }
    if (!r?.ok) return { status: 'unavailable', description: r?.description };
    const bio = r.result?.bio;
    if (!bio || !String(bio).trim()) return { status: 'empty' };
    return { status: bioHasReferralLink(bio, userId) ? 'ok' : 'missing_link' };
}

export async function handleDailyClaim(req, res, db, userId, { eligibleFilter }) {
    const users = db.collection('users');
    const user = await users.findOne({ _id: userId }, {
        projection: { isBanned: 1, accountLocked: 1, multiAccountFlag: 1, channelVerified: 1, dailyClaimDay: 1, dailyClaimLastDate: 1, dailyClaimTotal: 1, dailyClaimLastAttemptAt: 1 },
    });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
    if (user.isBanned) return res.status(403).json({ ok: false, error: 'banned' });

    const todayStart = todayStartBD();
    const path = computePath(user, todayStart);
    if (path.claimedToday) {
        return res.status(200).json({ ok: false, error: 'daily_already_claimed', ...pathPayload(user, userId) });
    }

    // Throttle verify attempts (atomic: only one request per DAILY_CLAIM_MIN_GAP_MS gets through,
    // which also kills double-taps and request floods before they reach the Telegram API).
    const now = Date.now();
    const gate = await users.updateOne(
        { _id: userId, $or: [{ dailyClaimLastAttemptAt: { $exists: false } }, { dailyClaimLastAttemptAt: { $lte: new Date(now - DAILY_CLAIM_MIN_GAP_MS) } }] },
        { $set: { dailyClaimLastAttemptAt: new Date(now) } }
    );
    if (!gate.matchedCount) return res.status(429).json({ ok: false, error: 'daily_claim_too_fast' });

    // 1) Verify the bio — no coins on anything but a confirmed match.
    const bio = await checkBio(userId);
    const verifyStatus = { ok: 'verified', empty: 'bio_empty', missing_link: 'bio_link_missing', unavailable: 'bio_unavailable' }[bio.status];
    await users.updateOne({ _id: userId }, { $set: { dailyClaimVerifyStatus: verifyStatus, dailyClaimVerifyAt: new Date() } }).catch(() => {});
    if (bio.status !== 'ok') {
        const error = { empty: 'bio_empty_or_hidden', missing_link: 'bio_link_missing', unavailable: 'bio_unavailable' }[bio.status];
        return res.status(200).json({ ok: false, error, link: referralLinkFor(userId) });
    }

    // 2) Account must be allowed to earn (same rule as every other reward).
    // 3) Atomic payout, guarded by the claim date we just read.
    const reward = path.reward;
    const prevDateFilter = user.dailyClaimLastDate ? { dailyClaimLastDate: user.dailyClaimLastDate } : { dailyClaimLastDate: { $exists: false } };
    const paid = await users.findOneAndUpdate(
        { _id: userId, isBanned: { $ne: true }, ...prevDateFilter, $and: [eligibleFilter] },
        {
            $set: { dailyClaimDay: path.nextDay, dailyClaimLastDate: todayStart },
            $inc: { wtcBalance: reward, lifetimeWtcEarned: reward, dailyClaimTotal: 1 },
        },
        { returnDocument: 'after' }
    );
    if (!paid) {
        const fresh = await users.findOne({ _id: userId }, { projection: { dailyClaimDay: 1, dailyClaimLastDate: 1, dailyClaimTotal: 1, multiAccountFlag: 1, isBanned: 1 } });
        if (fresh && computePath(fresh, todayStart).claimedToday) {
            return res.status(200).json({ ok: false, error: 'daily_already_claimed', ...pathPayload(fresh, userId) });
        }
        if (fresh?.isBanned) return res.status(403).json({ ok: false, error: 'banned' });
        return res.status(403).json({ ok: false, error: 'account_under_review' });
    }

    // Reward transaction / claim history (unique per user+day, so a duplicate row is impossible).
    try {
        await db.collection('dailyClaims').insertOne({
            userId, day: path.nextDay, reward, dayKey: todayStart, balanceAfter: paid.wtcBalance,
            verification: 'bio_link_verified', link: referralLinkFor(userId), createdAt: new Date(),
        });
    } catch (e) { if (e?.code !== 11000) console.error('dailyClaims log failed:', e?.message); }

    return res.status(200).json({ ok: true, reward, day: path.nextDay, balance: paid.wtcBalance, ...pathPayload(paid, userId) });
}
