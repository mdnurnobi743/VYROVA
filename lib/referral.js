// lib/referral.js — Season 2 + FIX: referral earnings now tracked separately
// + ATOMIC FIX: each milestone's flag-check-and-set is now a single atomic
// operation, closing a race window where two near-simultaneous triggers
// (e.g. rapid double-tap task completion, or two devices) could both read
// the flag as false and both award the same milestone twice.
//
// লেখার রেফারেল রিওয়ার্ড ৩টা ধাপে দেওয়া হয় (আসল সংখ্যা lib/constants.js-এর
// REFERRAL_REWARDS-এ), প্রতিটা ধাপ যখন referred user (যাকে রেফার করা হয়েছে)
// প্রথমবার সেই মাইলস্টোনে পৌঁছায়:
//   ধাপ ১: channel + community verify করলে
//   ধাপ ২: ৫টা task সম্পন্ন করলে
//   ধাপ ৩: ২০টা ads সম্পন্ন করলে
//
// "valid referral" (যেটা api/withdraw.js
// খরচ করে withdraw করার জন্য) আগে শুধু ধাপ ৩ (20 ads) ছুঁলেই সেট হয়ে
// যেত — task সংখ্যা ধর্তব্যই ছিল না। এখন valid হতে হলে ধাপ ২ আর ধাপ ৩
// দুটোই লাগবে (৫ tasks AND ২০ ads, একসাথে) — নিচে referralValidDone
// ফ্ল্যাগ দিয়ে আলাদাভাবে ট্র্যাক করা হচ্ছে, ধাপ ৩-এর reward-flag থেকে
// আলাদা করে রাখা হয়েছে যাতে দুটো জিনিস মিশে না যায়।
//
// ⚠️ REMOVED (earlier update) — a daily per-referrer milestone-reward cap
// (REFERRAL_DAILY_MILESTONE_CAP) briefly lived here, blocking a referrer's
// milestone payouts once they crossed 15/day. Taken back out on request —
// it was catching legitimate high-activity days too, not just abuse. The
// actual anti-abuse protection is the referral-SIGNUP velocity ALERT in
// api/user.js (20+ signups under one referrer within 2 minutes → admin
// gets notified, nothing auto-blocked — admin decides whether to Lock).
//
// প্রতিটা ধাপ মাত্র একবারই দেওয়া হবে — তার জন্য referred user-এর ডকুমেন্টে
// referralStep1Done / Step2Done / Step3Done ফ্ল্যাগ রাখা হচ্ছে, এবং প্রতিটা
// ফ্ল্যাগের check+set এখন atomic (findOneAndUpdate দিয়ে) — তাই concurrent
// কল থেকে ডাবল-অ্যাওয়ার্ড হওয়ার সুযোগ নেই।
//
// reward সরাসরি wtcBalance-এ যোগ হয়, এবং আলাদা করে `referralWtcEarned`
// ফিল্ডেও যোগ হয় যাতে "Refer" ট্যাবে referral-থেকে-আসা টাকার real সংখ্যা
// দেখানো যায়।

import {
    REFERRAL_REWARDS,
    REFERRAL_STEP2_TASK_COUNT,
    REFERRAL_STEP3_AD_COUNT,
    REFERRAL_STEP5_SPIN_COUNT,
} from './constants.js';
import { tgSend } from './telegram.js';

// sent to the REFERRER the moment one of their referrals
// becomes "valid" (see the combined tasks+ads check below). This valid
// referral is what api/withdraw.js spends — 1 per withdrawal, after the
// user's first (free) one.
function validReferralNotification() {
    return (
        `🎉 <b>Congratulations!</b>\n\n` +
        `One of your referrals has been successfully verified ✅\n\n` +
        `You've unlocked <b>1 valid referral</b> — this lets you make your next withdrawal. ` +
        `Keep sharing your invite link to unlock more! 🚀`
    );
}

// stats = { channelVerified?, completedTasksCount?, lifetimeAdsWatched? }
// — যেকোনো একটা বা একাধিক পাস করতে পারেন, যেটা সদ্য changed হয়েছে
export async function maybeAwardReferralMilestones(db, referredUserId, stats = {}) {
    const users = db.collection('users');
    const referredUser = await users.findOne(
        { _id: referredUserId },
        {
            projection: {
                referredBy: 1, referralStep1Done: 1, referralStep2Done: 1, referralStep3Done: 1, referralStep4Done: 1, referralStep5Done: 1, referralValidDone: 1,
                // needed for the combined tasks+ads "valid" check below.
                // Callers (api/earn.js) only ever pass ONE stat at a time in
                // `stats` (whichever just changed), never both tasks AND ads
                // together — so the combined check reads the referred user's
                // actual current counts from the DB instead, regardless of
                // which single stat triggered this particular call.
                completedTasks: 1, lifetimeAdsWatched: 1,
            },
        }
    );
    if (!referredUser || !referredUser.referredBy) return; // কেউ এই ইউজারকে রেফার করেনি
    if (referredUser.referredBy === referredUserId) return; // ⚠️ self-referral guard — defense in depth

    const referrerId = referredUser.referredBy;

    // ── এই ৪টা রিওয়ার্ড-মাইলস্টোন যার যার নিজস্ব থ্রেশহোল্ড ছুঁলেই একবার
    //    করে ফায়ার করে, একে অপরের থেকে independent — শুধু বোনাস WTC। ──
    // 4th milestone: referredUser এর প্রথমবার Video-section
    // lootbox claim করলে referrer একবার +90 WTC পাবে (see
    // REFERRAL_REWARDS.step4_firstLootbox, lib/constants.js). Caller
    // (handleClaimLootbox, api/earn.js) শুধু তখনই stats.lootboxClaimed:
    // true পাঠায় যখন এটাই ওই user এর জীবনের প্রথম সফল lootbox claim।
    const steps = [
        { key: 'referralStep1Done', met: !!stats.channelVerified, reward: REFERRAL_REWARDS.step1_verified },
        { key: 'referralStep2Done', met: stats.completedTasksCount !== undefined && stats.completedTasksCount >= REFERRAL_STEP2_TASK_COUNT, reward: REFERRAL_REWARDS.step2_tenTasks },
        { key: 'referralStep3Done', met: stats.lifetimeAdsWatched !== undefined && stats.lifetimeAdsWatched >= REFERRAL_STEP3_AD_COUNT, reward: REFERRAL_REWARDS.step3_twentyAds },
        { key: 'referralStep4Done', met: !!stats.lootboxClaimed, reward: REFERRAL_REWARDS.step4_firstLootbox },
        // 5th milestone: referred user completes 20 spins → referrer +100 WTC (once).
        { key: 'referralStep5Done', met: stats.lifetimeSpins !== undefined && stats.lifetimeSpins >= REFERRAL_STEP5_SPIN_COUNT, reward: REFERRAL_REWARDS.step5_twentySpins },
    ];

    for (const step of steps) {
        if (!step.met || referredUser[step.key]) continue;

        // ⚠️ ATOMIC — flag-check আর flag-set একই operation-এ। দুটো concurrent
        // call এলে একটাই এই filter ($ne:true) পাস করবে, অন্যটা null ফেরত পাবে
        // এবং নিচের reward-credit স্কিপ করবে।
        const claimed = await users.findOneAndUpdate(
            { _id: referredUserId, [step.key]: { $ne: true } },
            { $set: { [step.key]: true } },
            { returnDocument: 'after' }
        );
        if (!claimed) continue; // অন্য concurrent call কিছু মিলিসেকেন্ড আগেই claim করে ফেলেছে

        await users.findOneAndUpdate(
            // ⚠️ locked/banned referrer skipped — the one anti-abuse gate kept.
            { _id: referrerId, isBanned: { $ne: true }, accountLocked: { $ne: true } },
            {
                $inc: {
                    wtcBalance: step.reward, lifetimeWtcEarned: step.reward, referralWtcEarned: step.reward,
                    // ⚠️ REMOVED (this update) — Season 3 "777" lottery ticket award.
                    // The lottery feature itself is gone (see lib/constants.js);
                    // this WTC referral reward is untouched, still fires exactly
                    // as before for every step.
                },
            }
        );
    }

    // ── "Valid referral" — ⚠️ CHANGED (this update): এখন আলাদা করে চেক হয়,
    //    ধাপ ৩-এর reward-fire-এর সাথে বাঁধা না। দুইটা শর্তই লাগবে একসাথে:
    //    কমপক্ষে REFERRAL_STEP2_TASK_COUNT (৫) tasks AND কমপক্ষে
    //    REFERRAL_STEP3_AD_COUNT (২০) ads — তবেই referrer-এর জন্য এই
    //    referral "valid" গণ্য হবে, withdraw-এর জন্য খরচযোগ্য। DB-তে থাকা
    //    referred user-এর real, up-to-date counts দিয়ে check হচ্ছে (এই
    //    call-এর stats parameter দিয়ে না — সেখানে একবারে একটাই stat আসে)। ──
    const tasksOk = (referredUser.completedTasks || []).length >= REFERRAL_STEP2_TASK_COUNT;
    const adsOk = (referredUser.lifetimeAdsWatched || 0) >= REFERRAL_STEP3_AD_COUNT;
    if (tasksOk && adsOk && !referredUser.referralValidDone) {
        const claimedValid = await users.findOneAndUpdate(
            { _id: referredUserId, referralValidDone: { $ne: true } },
            { $set: { referralValidDone: true } },
            { returnDocument: 'after' }
        );
        if (claimedValid) {
            const referrerUpdate = await users.findOneAndUpdate(
                { _id: referrerId, isBanned: { $ne: true }, accountLocked: { $ne: true } },
                { $inc: { validReferralCount: 1 } },
                { returnDocument: 'after' }
            );
            if (referrerUpdate) {
                tgSend(referrerId, validReferralNotification()).catch(() => {});
            }
        }
    }
}
