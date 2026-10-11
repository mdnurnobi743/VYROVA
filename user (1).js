// api/user.js — CONSOLIDATED + SECURITY FIX (Telegram initData verification)
//
// Key change: previously the client-supplied userId was trusted as-is — anyone
// could open browser DevTools, call the API directly, and pass someone else's
// userId. Now every request requires Telegram's `initData` (a signed string)
// which the server verifies cryptographically — nobody can forge it without
// the bot token, so userId can no longer be spoofed.
//
//   POST /api/user   body: { action: 'init', initData, fingerprint }
//   POST /api/user   body: { action: 'acceptTerms', initData, version }   — ⚠️ NEW (big update)
//   GET  /api/user?action=checkJoin&initData=...
//   GET  /api/user?action=profile&initData=...

import { connectToDatabase } from '../lib/mongodb.js';
import { todayBD, REFERRAL_VELOCITY_WINDOW_MS, REFERRAL_VELOCITY_THRESHOLD, IP_SIGNUP_VELOCITY_THRESHOLD, IP_SIGNUP_VELOCITY_WINDOW_MS, TERMS_VERSION, TERMS_APPLY_TO_EXISTING_USERS } from '../lib/constants.js';
import { ensureDailyReset } from '../lib/dailyReset.js';
import { checkAndRecordFingerprint } from '../lib/fingerprintCheck.js';
import { isMember, OFFICIAL_CHANNEL, COMMUNITY_GROUP, tgSend } from '../lib/telegram.js';
import { maybeAwardReferralMilestones } from '../lib/referral.js';
import { verifyTelegramInitData } from '../lib/telegramAuth.js';
import { getClientIp, checkDevice, claimDevice, claimDeviceForUser, getOwnerPublicInfo, recordSignupAndCheckVelocity } from '../lib/ipRegistry.js';

const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID;

async function handleInit(req, res, db) {
    const initData = req.body?.initData;
    const verified = verifyTelegramInitData(initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });

    const userId = String(verified.user.id);
    const firstName = verified.user.first_name;
    const username = verified.user.username;
    const referrerCode = verified.startParam; // ✅ comes from verified initData — client can't send a different one separately
    const { fingerprint } = req.body;

    // ── Season 4: device-fingerprint gate (IP kept only as fallback — see
    // lib/ipRegistry.js), checked on EVERY init (new or returning user)
    // since the client calls action:init on every app boot. A different
    // account already owning this device blocks entry outright — the
    // client shows the "Device Already In Use" screen with the owner's
    // public info and lets the person log into that account, or force-claim
    // this device for their own (resets balance).
    const clientIp = getClientIp(req);
    const deviceCheck = await checkDevice(db, fingerprint, clientIp, userId);
    if (deviceCheck.blocked) {
        const owner = await getOwnerPublicInfo(db, deviceCheck.ownerId);
        return res.status(409).json({ ok: false, error: 'ip_in_use', owner });
    }
    // soft IP-fallback collision (see lib/ipRegistry.js checkDevice).
    // Not blocked, but worth a quiet admin-side breadcrumb in case a real
    // multi-account pattern later shows up on the SAME key from the SAME
    // userId repeatedly — never touches isBanned, never alerts per-event.
    if (deviceCheck.fallbackCollision) {
        db.collection('users').updateOne(
            { _id: userId },
            { $set: { ipFallbackCollisionFlag: true, ipFallbackCollisionWith: deviceCheck.ownerId } }
        ).catch(() => {});
    }

    const users = db.collection('users');
    const existing = await users.findOne({ _id: userId });
    if (existing) {
        if (deviceCheck.unclaimed) await claimDevice(db, deviceCheck.key, userId); // link a fresh device to a returning user
        // refresh the "still alive" clock every time the app opens.
        // Powers the 90-day dead-account TTL below: 3 months with the app
        // never once opened and the whole doc auto-deletes (see
        // models/schema.js). If this same Telegram ID opens the app again
        // after that, `existing` here comes back null and they fall straight
        // into the newUser branch below — a genuinely fresh account, same as
        // if they'd never used the app at all.
        await users.updateOne({ _id: userId }, { $set: { lastActiveAt: new Date() } });
        // terms grandfathering. Only when the admin set
        // TERMS_APPLY_TO_EXISTING_USERS = false: accounts that predate the
        // terms system are marked as accepted instead of being asked.
        if (!TERMS_APPLY_TO_EXISTING_USERS && existing.termsVersion == null) {
            await users.updateOne(
                { _id: userId, termsVersion: { $exists: false } },
                { $set: { termsVersion: TERMS_VERSION, termsAcceptedAt: new Date(), termsGrandfathered: true } }
            ).catch(() => {});
        }
        return res.status(200).json({ ok: true, alreadyExists: true });
    }

    // Two different auto-deletes can land a returning Telegram ID here with
    // `existing === null` even though they've used the app before:
    //   1) a banned user's doc, 60 days after bannedAt (see models/schema.js) — the
    //      stillBanned check right below catches this via the separate,
    //      never-expiring `bannedTelegramIds` registry, so the ban still holds.
    //   2) a genuinely inactive user's doc, 90 days after lastActiveAt (also
    //      models/schema.js) — NOT banned, so nothing blocks them below: they
    //      fall straight into creating newUser and get a real fresh start,
    //      which is the intended behavior for a "dead" (not banned) account.
    const stillBanned = await db.collection('bannedTelegramIds').findOne({ _id: userId });
    if (stillBanned) return res.status(403).json({ ok: false, error: 'banned' });

    const newUser = {
        _id: userId,
        firstName: firstName || 'User',
        telegramUsername: username || 'N/A',
        wtcBalance: 0,
        usdtBalance: 0,
        lifetimeWtcEarned: 0,
        pendingVideoWTC: 0,
        referralCount: 0,
        weeklyReferralCount: 0,
        totalInvites: 0,
        referredBy: (referrerCode && referrerCode !== userId) ? String(referrerCode) : null,
        referralStep1Done: false,
        referralStep2Done: false,
        referralStep3Done: false,
        completedTasks: [],
        isBanned: false,
        channelVerified: false,
        withdrawalCount: 0,
        lifetimeAdsWatched: 0,
        adsWatchedToday: 0,
        adsgramDailyCountToday: 0,
        adsgramSpecialCountToday: 0,
        monetagCountToday: 0,
        gigaCountToday: 0,
        uslCountToday: 0,
        // ⚠️ REMOVED — tadsCountToday (network deleted)
        // spin wheel fields. dailySpinsUsed (daily-count model)
        // removed entirely — replaced by lastFreeSpinAt (a rolling-cooldown
        // timestamp, checked against SPIN_FREE_COOLDOWN_HOURS in
        // lib/constants.js), which is simply absent until the user's first
        // spin, so it's deliberately NOT initialized here. bonusSpinsAvailable
        // still does NOT reset — it only grows, via referral signups (see the
        // referrerAfter update just above) and is spent first in handleSpin.
        bonusSpinsAvailable: 0,
        monetagPopupCountToday: 0,
        usedAdStarts: [],
        usedLootboxStarts: [],
        usedSpinStarts: [], // ⚠️ NEW — single-use spin-ad-gate tokens, see handleSpin in api/earn.js
        usedTaskStarts: [],
        dailyVideoWtcMined: 0,
        gameClaimsToday: 0, // 🎮 NEW
        streakCount: 0, streakLastClaimDate: null, // 🔥 NEW — daily login streak
        tasksCompletedToday: 0,
        lastResetDate: todayBD(),
        welcomeBonusClaimed: false,
        createdAt: new Date(),
        lastActiveAt: new Date(), // ⚠️ NEW — see the dead-account TTL note above / models/schema.js
        multiAccountFlag: false,
        multiAccountSiblings: [],
        validReferralCount: 0,      // ⚠️ NEW — Season 4, +1 when a referral completes all 3 steps (lib/referral.js)
        spinsSinceWithdraw: 0,      // ⚠️ NEW — spins done since the last withdrawal; WITHDRAW_SPINS_REQUIRED are consumed per withdraw
        usedValidReferrals: 0,      // ⚠️ NEW — Season 4, +1 each withdraw after the user's first (free) one
        // wallet lock (see WALLET_CHANGE_PENALTY_PERCENT, lib/constants.js).
        // Set on the user's first-ever withdrawal, reused automatically after that.
        lockedWalletMethod: null,
        lockedWalletAddress: null,
        walletChangeUsed: false,   // lifetime one-time allowance to change the locked wallet
        // Terms & Conditions acceptance (see TERMS_VERSION,
        // lib/constants.js). Stays null until the user taps "agree" in the app
        // (action:'acceptTerms' below); earning + withdrawing are blocked until then.
        termsVersion: null,
        termsAcceptedAt: null,
        // ⚠️ REMOVED (this update) — luckyTickets / "777" lottery field. Feature removed entirely, see lib/constants.js.
    };

    // raw-IP signup velocity gate (see IP_SIGNUP_VELOCITY_* in
    // lib/constants.js for the full reasoning). Unlike the device-fingerprint
    // gate above, this can't be dodged by a script sending a fresh fake
    // fingerprint per account — it's keyed on the actual client IP the
    // request arrived from. Crossing the threshold auto-locks the account
    // BEFORE it's even inserted (accountLocked blocks withdrawal — see
    // api/withdraw.js), then alerts the admin. This is a harder response
    // than the referral-velocity heuristic above (which is alert-only) on
    // purpose: that one can be tripped by a genuinely viral real promotion,
    // this one — a burst of brand-new accounts from one IP — has no
    // legitimate-organic explanation, so locking first and letting the
    // admin unlock on review is the safe default here.
    const { count: ipSignupCount } = await recordSignupAndCheckVelocity(db, clientIp);
    if (ipSignupCount >= IP_SIGNUP_VELOCITY_THRESHOLD) {
        newUser.accountLocked = true;
        newUser.velocityFlaggedAt = new Date();
        newUser.velocityFlaggedReason = 'ip_signup_velocity';
    }

    try {
        await users.insertOne(newUser);
    } catch (err) {
        if (err.code === 11000) return res.status(200).json({ ok: true, alreadyExists: true });
        throw err;
    }

    // admin alert for the IP signup velocity lock above. Fires once
    // right at the threshold, then every +10 accounts after that while the
    // same burst keeps going (mirrors the switchCount modulo pattern in
    // lib/ipRegistry.js) — enough to notice a large ongoing farm run without
    // spamming one message per account.
    if (ipSignupCount >= IP_SIGNUP_VELOCITY_THRESHOLD && (ipSignupCount === IP_SIGNUP_VELOCITY_THRESHOLD || ipSignupCount % 10 === 0) && ADMIN_ID) {
        const minutes = Math.round(IP_SIGNUP_VELOCITY_WINDOW_MS / 60000);
        tgSend(
            ADMIN_ID,
            `🔒 <b>IP signup velocity — accounts auto-locked</b>\n\n` +
            `<b>${ipSignupCount}+</b> new accounts have signed up from IP <code>${clientIp}</code> within a few minutes — looks like a farming script, not real traffic.\n\n` +
            `Latest account (locked, withdrawal blocked): <code>${userId}</code>\n\n` +
            `Review and unlock manually if this turns out to be a legitimate shared network.`,
            { reply_markup: { inline_keyboard: [[{ text: '🔎 Review this account', callback_data: `lookup_${userId}` }]] } }
        ).catch(() => {});
    }

    if (newUser.referredBy) {
        const referrerId = newUser.referredBy;
        const now = new Date();
        // referral signup velocity lock (lib/constants.js
        // REFERRAL_VELOCITY_*). Every signup under this referrer pushes a
        // timestamp onto a capped rolling list (last 50 — plenty to check
        // a 2-minute window, negligible storage), then checks how many of
        // those timestamps fall inside the velocity window.
        const referrerAfter = await users.findOneAndUpdate(
            { _id: referrerId },
            {
                // +1 bonusSpinsAvailable per referral signup (per
                // admin request — "proti refer e ekta spin"). Doesn't reset
                // daily like the 3 free ad-gated spins (see dailyResetFields
                // in constants.js) — these accumulate and are spent first,
                // before the daily free pool (see handleSpin in api/earn.js).
                $inc: { referralCount: 1, weeklyReferralCount: 1, totalInvites: 1, bonusSpinsAvailable: 1 },
                $push: { recentReferralSignups: { $each: [now], $slice: -50 } },
            },
            { returnDocument: 'after' }
        );
        const referrerDoc = referrerAfter?.value !== undefined ? referrerAfter.value : referrerAfter;
        // this used to auto-lock the referrer
        // immediately (blocking their withdrawals + referral rewards).
        // Now it's ALERT-ONLY — the admin reviews and decides (Lock or
        // dismiss) from the alert or the user's info panel. No automatic
        // harm to the user just for tripping a heuristic; a legitimate
        // fast-growing promotion doesn't get punished by default.
        if (referrerDoc && !referrerDoc.accountLocked && !referrerDoc.velocityFlaggedAt) {
            const windowStart = Date.now() - REFERRAL_VELOCITY_WINDOW_MS;
            const recentCount = (referrerDoc.recentReferralSignups || [])
                .filter((t) => new Date(t).getTime() >= windowStart).length;
            if (recentCount >= REFERRAL_VELOCITY_THRESHOLD) {
                // ⚠️ Atomic guard (velocityFlaggedAt:{$exists:false}) — only
                // the first signup to cross the threshold sends the alert;
                // this is now purely informational (velocityFlaggedAt), it
                // does NOT block anything on its own — see accountLocked
                // (admin-set only now) for the actual enforcement flag.
                const justFlagged = await users.updateOne(
                    { _id: referrerId, velocityFlaggedAt: { $exists: false } },
                    { $set: { velocityFlaggedAt: now, velocityFlaggedReason: 'referral_velocity' } }
                );
                if (justFlagged.modifiedCount > 0 && ADMIN_ID) {
                    const minutes = Math.round(REFERRAL_VELOCITY_WINDOW_MS / 60000);
                    tgSend(
                        ADMIN_ID,
                        `🚩 <b>Referral velocity alert (no action taken)</b>\n\n` +
                        `Referrer <code>${referrerId}</code> just crossed <b>${REFERRAL_VELOCITY_THRESHOLD}+</b> referral signups within <b>${minutes} minutes</b> — no real promotion delivers signups this fast.\n\n` +
                        `Nothing is blocked — check their referral list, then Lock if it looks fake or ignore if it's a real promotion.`,
                        { reply_markup: { inline_keyboard: [[{ text: '🔎 Review this account', callback_data: `lookup_${referrerId}` }]] } }
                    ).catch(() => {});
                }
            }
        }
    }

    await claimDevice(db, deviceCheck.key, userId); // first account on this device — claim it

    // NOTE — checkAndRecordFingerprint (lib/fingerprintCheck.js) only sets
    // multiAccountFlag for admin review here; it does NOT auto-ban. Real
    // one-account-per-device enforcement is the hard block up in checkDevice()
    // above. (An earlier version of this comment described an auto-ban path
    // that was intentionally reverted — see fingerprintCheck.js's own note —
    // fixed here so it stops contradicting the actual code.)
    const fpResult = await checkAndRecordFingerprint(db, userId, fingerprint);
    return res.status(200).json({ ok: true, created: true, multiAccountFlagged: fpResult.flagged });
}

// Season 4 "Switch account" — the way forward from the device-in-use block
// screen besides logging into the account that already owns this device.
// Force-claims the device key (fingerprint, or IP as fallback — see
// lib/ipRegistry.js:registryKey) for the CALLER's Telegram account and wipes
// their balance as the anti-abuse cost of doing so. See
// lib/ipRegistry.js:claimDeviceForUser for exactly what gets reset.
async function handleSwitchAccount(req, res, db) {
    const initData = req.body?.initData;
    const verified = verifyTelegramInitData(initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const userId = String(verified.user.id);
    const { fingerprint } = req.body;

    const stillBanned = await db.collection('bannedTelegramIds').findOne({ _id: userId });
    if (stillBanned) return res.status(403).json({ ok: false, error: 'banned' });

    const existing = await db.collection('users').findOne({ _id: userId });
    if (!existing) return res.status(404).json({ ok: false, error: 'user_not_found' });

    const clientIp = getClientIp(req);
    const key = fingerprint && fingerprint.length >= 16 ? fingerprint : `ip:${clientIp}`;
    const result = await claimDeviceForUser(db, key, userId);
    // claimDeviceForUser now enforces a cooldown between switches on
    // the same device (see lib/ipRegistry.js for why). Surface it clearly
    // instead of silently no-op'ing.
    if (!result.ok) {
        const hours = Math.ceil(result.retryAfterMs / (60 * 60 * 1000));
        return res.status(429).json({
            ok: false, error: 'switch_cooldown', retryAfterMs: result.retryAfterMs,
            message: `This device was already switched recently. Try again in about ${hours}h, or log into the existing account instead.`,
        });
    }
    return res.status(200).json({ ok: true, switched: true });
}

// records that the user agreed to the Terms &
// Conditions shown on first open. `version` must match the server's
// TERMS_VERSION, so a stale client can't accept an outdated text.
async function handleAcceptTerms(req, res, db) {
    const verified = verifyTelegramInitData(req.body?.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const userId = String(verified.user.id);

    if (Number(req.body?.version) !== TERMS_VERSION) {
        return res.status(409).json({ ok: false, error: 'terms_outdated', termsVersion: TERMS_VERSION });
    }
    const r = await db.collection('users').updateOne(
        { _id: userId, isBanned: { $ne: true } },
        { $set: { termsVersion: TERMS_VERSION, termsAcceptedAt: new Date() } }
    );
    if (!r.matchedCount) return res.status(404).json({ ok: false, error: 'user_not_found' });
    return res.status(200).json({ ok: true, termsVersion: TERMS_VERSION });
}

async function handleCheckJoin(req, res, db) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    const verified = verifyTelegramInitData(req.query.initData);
    if (!verified.ok) return res.status(401).json({ joined: false, error: 'unauthorized', reason: verified.error });
    const userId = String(verified.user.id);

    try {
        const [inChannel, inGroup] = await Promise.all([
            isMember(userId, OFFICIAL_CHANNEL),
            isMember(userId, COMMUNITY_GROUP),
        ]);
        const joined = inChannel && inGroup;

        if (joined) {
            try {
                await db.collection('users').updateOne({ _id: userId }, { $set: { channelVerified: true } });
                await maybeAwardReferralMilestones(db, userId, { channelVerified: true });
            } catch { /* non-blocking */ }
        } else {
            // this DB read+write had no try/catch of its own, so a
            // transient Mongo error here (not just isMember failing) fell
            // through to the outer catch below, which used to return
            // `joined: true` — see that fix for why this branch is wrapped now too.
            try {
                const existing = await db.collection('users').findOne({ _id: userId }, { projection: { channelVerified: 1 } });
                if (existing?.channelVerified) {
                    await db.collection('users').updateOne({ _id: userId }, { $set: { channelVerified: false } });
                    return res.status(200).json({ joined: false, inChannel, inGroup, leftAfterVerifying: true });
                }
            } catch { /* non-blocking — worst case this one flag update is skipped, joined:false below still holds */ }
        }

        return res.status(200).json({ joined, inChannel, inGroup });
    } catch (err) {
        console.error('checkJoin error:', err);
        // this used to return `joined: true` here, meaning
        // ANY transient error (a DB blip, isMember throwing unexpectedly)
        // waved the user through the join-gate as if they were a verified
        // member, with nothing checked at all. Fail CLOSED instead — a
        // genuine member just sees "not joined yet" for a moment and can
        // tap "check now" again; a non-member correctly stays gated during
        // the same failure window. Matches the fail-closed pattern used
        // everywhere else in this codebase (see isMember() in telegram.js).
        return res.status(200).json({ joined: false, error: 'check_failed' });
    }
}

async function handleProfile(req, res, db) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    const verified = verifyTelegramInitData(req.query.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const userId = String(verified.user.id);

    const users = db.collection('users');
    await ensureDailyReset(users, userId);

    const user = await users.findOne({ _id: userId });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });

    const { multiAccountSiblings, multiAccountFingerprint, ...safeUser } = user;
    return res.status(200).json({ ok: true, user: safeUser });
}

export default async function handler(req, res) {
    const { db } = await connectToDatabase();

    if (req.method === 'POST') {
        const { action } = req.body || {};
        if (action === 'init') return handleInit(req, res, db);
        if (action === 'switchAccount') return handleSwitchAccount(req, res, db);
        if (action === 'acceptTerms') return handleAcceptTerms(req, res, db);
        return res.status(400).json({ ok: false, error: 'unknown_action' });
    }

    if (req.method === 'GET') {
        const { action } = req.query;
        if (action === 'checkJoin') return handleCheckJoin(req, res, db);
        if (action === 'profile') return handleProfile(req, res, db);
        return res.status(400).json({ ok: false, error: 'unknown_action' });
    }

    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
            }
