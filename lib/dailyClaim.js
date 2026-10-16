// lib/dailyClaim.js — Home › Daily Claim (+20 … +140 VYRO COIN, 7-day path)
//
// HOW THE VERIFICATION WORKS (real, server-side — nothing is trusted from the client):
//   A Mini App can NOT read anybody's Telegram bio. The Bot API can: `getChat(chat_id = <user id>)`
//   returns the `bio` of a private chat for users who have talked to the bot (and whose bio privacy
//   allows it). So the claim is verified here, on the server, with the bot token:
//     1. the user id comes ONLY from the signed Telegram initData (see api/earn.js),
//     2. we build that user's own invite link (same format the Refer tab shows),
//     3. we call getChat and require the bio to contain exactly that link,
//     4. only then is the reward credited — in ONE atomic update that also enforces
//        "once per Bangladesh day", advances the 7-day path and adds the VYRO COIN.
//   If the bio is empty / hidden / unreachable / has someone else's link → no coins, and the user
//   gets a precise reason (see `reason` in the error response).
//
// Balance: credited straight into the existing users.wtcBalance (+ lifetimeWtcEarned), exactly like
// every other reward in this project. History lives in `dailyClaims` (one doc per user per day).

import { tgApi } from './telegram.js';
import {
    DAILY_CLAIM_REWARDS, DAILY_CLAIM_ATTEMPT_COOLDOWN_SECONDS, todayStartBD, todayBD,
} from './constants.js';

const MINI_APP_URL = 'https://t.me/Vyrova_bot'; // must match MINI_APP_BASE in index.html / MINI_APP_URL in api/bot.js
const DAY_MS = 86400000;
const CYCLE = DAILY_CLAIM_REWARDS.length; // 7

export function referralLinkFor(userId) {
    return `${MINI_APP_URL}?startapp=${userId}`;
}

// Does `bio` contain THIS user's invite link? Accepts the usual ways Telegram shows/stores it:
// https://t.me/Vyrova_bot?startapp=ID · t.me/… · telegram.me/… · http:// · any letter case.
// The id must end on a non-digit boundary so "…=123" never matches someone else's "…=1234".
export function bioContainsLink(bio, userId) {
    if (typeof bio !== 'string' || !bio) return false;
    const re = new RegExp(
        `(?:https?:\\/\\/)?(?:www\\.)?(?:t|telegram)\\.me\\/vyrova_bot\\?startapp=${String(userId).replace(/[^0-9]/g, '')}(?![0-9A-Za-z_])`,
        'i'
    );
    return re.test(bio);
}

// Asks Telegram for the user's bio. Returns { ok:true, bio } or { ok:false, reason }.
//   reason: 'bio_unavailable' (bot can't see the user → they must press Start in the bot chat)
//           'bio_check_failed' (Telegram temporarily failing — try again)
async function fetchBio(userId) {
    try {
        const r = await tgApi('getChat', { chat_id: Number(userId) });
        if (!r || !r.ok) {
            const desc = String(r?.description || '').toLowerCase();
            if (desc.includes('chat not found') || desc.includes('forbidden') || desc.includes('blocked')) {
                return { ok: false, reason: 'bio_unavailable' };
            }
            console.error('dailyClaim getChat failed:', r?.description);
            return { ok: false, reason: 'bio_check_failed' };
        }
        return { ok: true, bio: typeof r.result?.bio === 'string' ? r.result.bio : '' };
    } catch (e) {
        console.error('dailyClaim getChat threw:', e?.message);
        return { ok: false, reason: 'bio_check_failed' };
    }
}

// Where is this user on the 7-day path right now? Pure function of the stored fields.
//   claimedToday → today's reward is already taken (dayToday = the day they claimed)
//   otherwise    → nextDay = the day they would claim now (1 if new / missed a day / finished Day 7)
export function computePath(user, todayStart = todayStartBD()) {
    const count = Math.min(Math.max(Number(user?.dailyClaimDay) || 0, 0), CYCLE);
    const last = user?.dailyClaimLastDate ? new Date(user.dailyClaimLastDate).getTime() : null;
    const t = todayStart.getTime();
    if (last !== null && last === t) {
        return { claimedToday: true, currentDay: count, completedDays: count, nextDay: null };
    }
    const consecutive = last !== null && (t - last) === DAY_MS;
    const nextDay = consecutive ? (count >= CYCLE ? 1 : count + 1) : 1;
    // days already done in the visible cycle: only when the streak is alive and the cycle is not finished
    const completedDays = consecutive && count < CYCLE ? count : 0;
    return { claimedToday: false, currentDay: nextDay, completedDays, nextDay };
}

// ── dailyClaimStatus ── read-only; what the Home card + popup render.
export async function handleDailyClaimStatus(req, res, db, userId) {
    const users = db.collection('users');
    const user = await users.findOne({ _id: userId }, {
        projection: { dailyClaimDay: 1, dailyClaimLastDate: 1, dailyClaimTotal: 1, dailyClaimLastCheck: 1, wtcBalance: 1, isBanned: 1 },
    });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
    const path = computePath(user);
    return res.status(200).json({
        ok: true,
        rewards: DAILY_CLAIM_REWARDS,
        referralLink: referralLinkFor(userId),
        claimedToday: path.claimedToday,
        currentDay: path.currentDay,
        completedDays: path.completedDays,
        nextReward: path.claimedToday ? null : DAILY_CLAIM_REWARDS[path.nextDay - 1],
        totalClaims: user.dailyClaimTotal || 0,
        lastCheck: user.dailyClaimLastCheck ? { status: user.dailyClaimLastCheck.status, at: user.dailyClaimLastCheck.at } : null,
        balance: user.wtcBalance || 0,
    });
}

// ── dailyClaim ── verify the bio, then pay (once per BD day).
export async function handleDailyClaim(req, res, db, userId, { eligibleFilter }) {
    const users = db.collection('users');
    const todayStart = todayStartBD();

    const user = await users.findOne({ _id: userId }, {
        projection: {
            isBanned: 1, accountLocked: 1, multiAccountFlag: 1, channelVerified: 1,
            dailyClaimDay: 1, dailyClaimLastDate: 1, dailyClaimAttemptAt: 1,
        },
    });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
    if (user.isBanned) return res.status(403).json({ ok: false, error: 'banned' });
    if (user.accountLocked) return res.status(403).json({ ok: false, error: 'account_locked' });
    if (user.multiAccountFlag && !user.channelVerified) return res.status(403).json({ ok: false, error: 'account_under_review' });

    const path = computePath(user, todayStart);
    if (path.claimedToday) {
        return res.status(200).json({ ok: false, error: 'daily_claim_already_done', currentDay: path.currentDay });
    }

    // Attempt throttle (atomic): only ONE verification per cooldown window can pass this gate,
    // so double-taps / scripts can't hammer Telegram or race the credit below.
    const now = new Date();
    const cutoff = new Date(now.getTime() - DAILY_CLAIM_ATTEMPT_COOLDOWN_SECONDS * 1000);
    const throttle = await users.findOneAndUpdate(
        { _id: userId, $or: [{ dailyClaimAttemptAt: { $exists: false } }, { dailyClaimAttemptAt: { $lte: cutoff } }] },
        { $set: { dailyClaimAttemptAt: now } },
        { returnDocument: 'after', projection: { _id: 1 } }
    );
    if (!throttle) return res.status(429).json({ ok: false, error: 'daily_claim_too_fast' });

    // 1) REAL verification against the user's actual Telegram bio
    const link = referralLinkFor(userId);
    const fetched = await fetchBio(userId);
    const saveCheck = (status) => users.updateOne({ _id: userId }, { $set: { dailyClaimLastCheck: { status, at: new Date() } } }).catch(() => {});

    if (!fetched.ok) {
        await saveCheck(fetched.reason);
        return res.status(200).json({ ok: false, error: 'bio_not_verified', reason: fetched.reason });
    }
    const bio = fetched.bio.trim();
    if (!bio) {
        await saveCheck('bio_empty');
        return res.status(200).json({ ok: false, error: 'bio_not_verified', reason: 'bio_empty' });
    }
    if (!bioContainsLink(bio, userId)) {
        await saveCheck('bio_missing_link');
        return res.status(200).json({ ok: false, error: 'bio_not_verified', reason: 'bio_missing_link' });
    }

    // 2) Pay — ONE atomic update. The filter re-checks the same state we read (optimistic
    //    concurrency), so two parallel requests can never both be paid for the same day.
    const day = path.nextDay;
    const reward = DAILY_CLAIM_REWARDS[day - 1];
    const prevDateFilter = user.dailyClaimLastDate
        ? { dailyClaimLastDate: user.dailyClaimLastDate }
        : { dailyClaimLastDate: { $exists: false } };
    const credited = await users.findOneAndUpdate(
        {
            _id: userId,
            isBanned: { $ne: true },
            accountLocked: { $ne: true },
            ...prevDateFilter,
            $and: [eligibleFilter],
        },
        {
            $set: {
                dailyClaimDay: day,
                dailyClaimLastDate: todayStart,
                dailyClaimLastCheck: { status: 'verified', at: now },
            },
            $inc: { wtcBalance: reward, lifetimeWtcEarned: reward, dailyClaimTotal: 1 },
        },
        { returnDocument: 'after', projection: { wtcBalance: 1 } }
    );

    if (!credited) {
        // lost a race (another request paid first) or eligibility changed
        const again = await users.findOne({ _id: userId }, { projection: { dailyClaimLastDate: 1, dailyClaimDay: 1 } });
        if (again && computePath(again, todayStart).claimedToday) {
            return res.status(200).json({ ok: false, error: 'daily_claim_already_done', currentDay: Number(again.dailyClaimDay) || day });
        }
        return res.status(409).json({ ok: false, error: 'conflict_retry' });
    }

    // 3) History record (one doc per user per BD day — the unique index makes a duplicate impossible)
    try {
        await db.collection('dailyClaims').insertOne({
            _id: `${userId}:${todayBD()}`,
            userId, day, reward,
            verification: 'verified',
            dayKey: todayBD(),
            linkChecked: link,
            balanceAfter: credited.wtcBalance || 0,
            createdAt: now,
        });
    } catch (e) {
        if (e?.code !== 11000) console.error('dailyClaims log failed (reward already credited):', e?.message);
    }

    return res.status(200).json({
        ok: true, reward, day, balance: credited.wtcBalance || 0,
        completedDays: day, nextDay: day >= CYCLE ? 1 : day + 1,
    });
}
