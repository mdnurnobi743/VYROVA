// lib/botGuard.js — ⚠️ NEW (update) — anti-script / Termux detection for ad claims.
//
// A real person watching ads is irregular: the ad takes a variable time to
// load, they look at it, tap the close button, then tap the next "Watch" a few
// seconds later. A script (Termux, curl loop, hacked client) calls
// adStart → waits the minimum → claimReward → immediately adStart again, with
// near-identical timing every cycle. We keep the last few claims per user
// (user.recentAdClaims: [{ s: adStartMs, c: claimMs, w: watchSeconds }]) and
// flag the account when the pattern looks mechanical:
//
//   Rule A  "no gap, super fast": N claims in a row where each ad was watched
//           for <= AD_BOT_MAX_WATCH_SECONDS AND the next ad was started
//           <= AD_BOT_MAX_IDLE_SECONDS after the previous claim.
//   Rule B  "metronome": the time between consecutive claims is almost the
//           same every time (spread <= AD_BOT_CYCLE_SPREAD_SECONDS) over N claims.
//   Rule C  "identical watch time": watch durations of N claims differ by
//           <= AD_BOT_WATCH_SPREAD_SECONDS (a real ad SDK never loads that evenly).
//
// On a hit the evidence is scored. Only a 🔴 "Likely script" account is locked
// (accountLocked + reason 'bot_pattern' — no withdraw, no more ad rewards, the
// triggering claim is rejected). Anything less clear is NOT locked: the admin gets a
// "Suspicious — NOT locked" alert with Lock / Profile / Ban buttons. All thresholds
// are tunable below.

export const AD_BOT_SAMPLE_SIZE = 5;            // consecutive claims examined for A and C
export const AD_BOT_MAX_WATCH_SECONDS = 7;      // Rule A — "watched" this briefly or less
export const AD_BOT_MAX_IDLE_SECONDS = 1;       // Rule A — next ad started within this after the last claim
export const AD_BOT_METRONOME_SAMPLES = 8;      // Rule B window
export const AD_BOT_CYCLE_SPREAD_SECONDS = 1;   // Rule B — max (longest − shortest) cycle
export const AD_BOT_CYCLE_MAX_SECONDS = 40;     // Rule B — only meaningful for back-to-back ads
export const AD_BOT_WATCH_SPREAD_SECONDS = 0.3;   // Rule C — max (longest − shortest) watch time

// Rule E "metronome gaps": the pause between finishing one ad and tapping the
// next (x.s − previous.c). People vary by seconds; a script repeats it within ~0.3s.
export const AD_BOT_GAP_SPREAD_SECONDS = 0.3;
export const AD_BOT_GAP_MAX_SECONDS = 20;       // only judge short, back-to-back gaps

export const AD_CLAIM_HISTORY_KEEP = 8;

// samples: oldest → newest, INCLUDING the claim being evaluated.
export function detectBotPattern(samples) {
    const n = samples.length;
    // Rule A
    if (n >= AD_BOT_SAMPLE_SIZE) {
        const last = samples.slice(-AD_BOT_SAMPLE_SIZE);
        const fastNoGap = last.every((x, i) =>
            x.w <= AD_BOT_MAX_WATCH_SECONDS &&
            (i === 0 || (x.s - last[i - 1].c) / 1000 <= AD_BOT_MAX_IDLE_SECONDS));
        if (fastNoGap) return { rule: 'A', detail: `${AD_BOT_SAMPLE_SIZE} ads in a row watched ≤${AD_BOT_MAX_WATCH_SECONDS}s each with ≤${AD_BOT_MAX_IDLE_SECONDS}s gap between them` };
        // Rule C
        const ws = last.map(x => x.w);
        if (Math.max(...ws) - Math.min(...ws) <= AD_BOT_WATCH_SPREAD_SECONDS) {
            return { rule: 'C', detail: `${AD_BOT_SAMPLE_SIZE} ads with near-identical watch time (${Math.min(...ws).toFixed(1)}–${Math.max(...ws).toFixed(1)}s)` };
        }
    }
    if (n >= AD_BOT_SAMPLE_SIZE) {
        const last = samples.slice(-AD_BOT_SAMPLE_SIZE);
        // Rule E
        const gaps = last.slice(1).map((x, i) => (x.s - last[i].c) / 1000);
        if (Math.max(...gaps) <= AD_BOT_GAP_MAX_SECONDS && Math.max(...gaps) - Math.min(...gaps) <= AD_BOT_GAP_SPREAD_SECONDS) {
            return { rule: 'E', detail: `${AD_BOT_SAMPLE_SIZE} ads with metronome-like pauses between them (${Math.min(...gaps).toFixed(1)}–${Math.max(...gaps).toFixed(1)}s)` };
        }
    }
    // Rule B
    if (n >= AD_BOT_METRONOME_SAMPLES) {
        const last = samples.slice(-AD_BOT_METRONOME_SAMPLES);
        const cycles = last.slice(1).map((x, i) => (x.c - last[i].c) / 1000);
        if (Math.max(...cycles) <= AD_BOT_CYCLE_MAX_SECONDS && Math.max(...cycles) - Math.min(...cycles) <= AD_BOT_CYCLE_SPREAD_SECONDS) {
            return { rule: 'B', detail: `${AD_BOT_METRONOME_SAMPLES} ads with a metronome-like cycle (${Math.min(...cycles).toFixed(1)}–${Math.max(...cycles).toFixed(1)}s apart)` };
        }
    }
    return null;
}

// a rule hit no longer means "lock".
//   1) The evidence is scored first (see buildEvidence → hint).
//   2) Only 🔴 "Likely script" accounts are LOCKED (no withdraw, no ad rewards).
//   3) 🟡 Unclear / 🟢 Likely real accounts are NOT locked and their claim still
//      pays — the admin just gets a "⚠️ Suspicious (not locked)" message with
//      🔒 Lock · 👤 Profile · 🚫 Ban buttons, at most once per 24h per user.
// opts.forceLock — always lock (used by the video rules V1/V2, which detect
//                  things a real person physically cannot do).
// opts.samples   — the claim list the rule was evaluated on (incl. the current
//                  claim), so the evidence matches exactly what triggered it.
// Returns true ONLY when the account is locked — callers reject the claim on true.
export const BOT_REVIEW_THROTTLE_MS = 24 * 3600 * 1000;

function buildEvidence(u, hit, samples) {
    const ageDays = u.createdAt ? Math.floor((Date.now() - new Date(u.createdAt).getTime()) / 86400000) : 0;
    const wCount = u.withdrawalCount || 0;
    const claims = (samples && samples.length ? samples : (u.recentAdClaims || [])).slice(-6);
    const watch = claims.map(x => `${x.w}s`).join(', ') || '—';
    const viewed = claims.map(x => typeof x.v === 'number' ? `${x.v}s` : '?').join(', ') || '—';
    const gapVals = claims.slice(1).map((x, i) => Math.max(0, (x.s - claims[i].c) / 1000));
    const gaps = gapVals.map(g => `${g.toFixed(1)}s`).join(', ') || '—';
    // simple hint — NOT a verdict, but 🔴 is what decides the automatic lock.
    // Principle: only things a real person cannot do count as script signals.
    let scriptSignals = 0, realSignals = 0;
    if (hit.rule === 'A') scriptSignals += 3;                      // ≤1s between ads, 5 times in a row — not humanly possible
    // pauses repeating almost to the decimal (counted ONCE, whether or not Rule E was the trigger)
    if (hit.rule === 'E' || (gapVals.length >= 4 && Math.max(...gapVals) - Math.min(...gapVals) <= 0.5)) scriptSignals += 2;
    const wVals = claims.map(x => x.w);
    if (wVals.length >= 5 && Math.max(...wVals) - Math.min(...wVals) <= 0.5) scriptSignals += 1;      // total times identical within 0.5s
    if (u.multiAccountFlag) scriptSignals += 1;
    if (ageDays < 2) scriptSignals += 1;
    if (wCount === 0 && (u.lifetimeAdsWatched || 0) > 80 && ageDays < 3) scriptSignals += 1;
    if (ageDays >= 7) realSignals += 1;
    if (wCount > 0) realSignals += 1;
    if ((u.validReferralCount || 0) > 0) realSignals += 1;
    if (hit.rule === 'B') realSignals += 1;  // metronome-only rule has the most false positives
    const likelyScript = scriptSignals >= 3 && scriptSignals > realSignals;
    const hint = likelyScript ? '🔴 Likely script'
               : realSignals >= 3 && realSignals > scriptSignals ? '🟢 Likely real user'
               : '🟡 Unclear — check profile';
    const text =
        `\n<b>Evidence</b>\n` +
        `Name: ${u.firstName || '—'} (@${u.telegramUsername || 'none'})\n` +
        `Account age: ${ageDays}d · Balance: ${u.wtcBalance || 0} WTC · Lifetime: ${u.lifetimeWtcEarned || 0} WTC\n` +
        `Withdrawals: ${wCount} · Valid referrals: ${u.validReferralCount || 0} · Ads lifetime: ${u.lifetimeAdsWatched || 0} (today ${u.adsWatchedToday || 0})\n` +
        `Multi-account flag: ${u.multiAccountFlag ? 'YES 🚩' : 'No'}\n` +
        `Tap→claim times (incl. loading): ${watch}\n` +
        `Ad on screen (client-reported): ${viewed}\n` +
        `Gaps between ads: ${gaps}\n` +
        `Hint: <b>${hint}</b> (script ${scriptSignals} / real ${realSignals})\n`;
    return { text, likelyScript };
}

export async function lockForBotPattern(db, userId, hit, tgSend, extra = '', opts = {}) {
    const users = db.collection('users');
    const adminId = process.env.ADMIN_TELEGRAM_ID;
    const before = await users.findOne({ _id: userId });
    if (!before) return false;
    if (before.accountLocked) return true;          // already locked — caller rejects the claim

    let evidence = '', likelyScript = false;
    try {
        const ev = buildEvidence(before, hit, opts.samples);
        evidence = ev.text; likelyScript = ev.likelyScript;
    } catch { /* evidence is best-effort — never block the alert */ }

    if (opts.forceLock || likelyScript) {
        const res = await users.findOneAndUpdate(
            { _id: userId, accountLocked: { $ne: true } },
            { $set: { accountLocked: true, accountLockedAt: new Date(), accountLockedReason: 'bot_pattern', botFlaggedAt: new Date() } }
        );
        if (res && adminId) {
            tgSend(adminId,
                `🤖 <b>Bot / script pattern detected (ads)</b>\n\n` +
                `User: <code>${userId}</code>\nRule ${hit.rule}: ${hit.detail}\n${extra}\n` +
                evidence +
                `\nThe account is now 🔒 locked (no withdraw, no ad rewards).`,
                { reply_markup: { inline_keyboard: [
                    [{ text: '🔓 Unlock', callback_data: `unlock_${userId}` }, { text: '👤 User Profile', callback_data: `lookup_${userId}` }],
                    [{ text: '🚫 Ban User', callback_data: `ban_${userId}` }],
                ] } }
            ).catch(() => {});
        }
        return !!res;
    }

    // Not clearly a script → do NOT lock. Tell the admin (once per 24h per user) and let the claim pay.
    const cutoff = new Date(Date.now() - BOT_REVIEW_THROTTLE_MS);
    const mark = await users.updateOne(
        { _id: userId, $or: [{ botReviewAt: { $exists: false } }, { botReviewAt: { $lt: cutoff } }] },
        { $set: { botReviewAt: new Date() } }
    );
    if (mark && mark.modifiedCount > 0 && adminId) {
        tgSend(adminId,
            `⚠️ <b>Suspicious ad pattern — NOT locked</b>\n\n` +
            `User: <code>${userId}</code>\nRule ${hit.rule}: ${hit.detail}\n${extra}\n` +
            evidence +
            `\nNothing was blocked. Lock the account yourself if you think it is a script.`,
            { reply_markup: { inline_keyboard: [
                [{ text: '🔒 Lock', callback_data: `lock_${userId}` }, { text: '👤 User Profile', callback_data: `lookup_${userId}` }],
                [{ text: '🚫 Ban User', callback_data: `ban_${userId}` }],
            ] } }
        ).catch(() => {});
    }
    return false;
}

// ════════════════════════════════════════════════════════════════════
// VIDEO SECTION rules (api/earn.js handleVideoClaim / handleClaimLootbox)
// ════════════════════════════════════════════════════════════════════
// Video WTC is earned by real watch time: 1 session token = [startTime, claimTime].
// A real client opens ONE session at a time (a fresh token right after each claim),
// so session windows never overlap. A script that mints many tokens and claims
// them together earns more than real time allows → overlapping windows.
//
//   Rule V1  "overlapping sessions": in the last VIDEO_BOT_SAMPLE_SIZE claims, at
//            least VIDEO_BOT_OVERLAP_HITS sessions started BEFORE the previous
//            one was claimed (by more than VIDEO_BOT_OVERLAP_TOLERANCE_SECONDS).
//   Rule V2  "claimed more than real time": total credited seconds in the last
//            VIDEO_BOT_SAMPLE_SIZE claims exceed the wall-clock span they cover.
//   Lootbox claims (the ad-gated "Claim me!" button) reuse the ad rules A/B/C
//   above, since each one is a real ad watch.
export const VIDEO_BOT_SAMPLE_SIZE = 5;
export const VIDEO_BOT_OVERLAP_HITS = 3;
export const VIDEO_BOT_OVERLAP_TOLERANCE_SECONDS = 5;
export const VIDEO_CLAIM_HISTORY_KEEP = 8;

// samples: oldest → newest { s: sessionStartMs, c: claimMs, a: secondsCredited }
export function detectVideoBotPattern(samples) {
    if (samples.length < VIDEO_BOT_SAMPLE_SIZE) return null;
    const last = samples.slice(-VIDEO_BOT_SAMPLE_SIZE);
    let overlaps = 0;
    for (let i = 1; i < last.length; i++) {
        if ((last[i - 1].c - last[i].s) / 1000 > VIDEO_BOT_OVERLAP_TOLERANCE_SECONDS) overlaps++;
    }
    if (overlaps >= VIDEO_BOT_OVERLAP_HITS) {
        return { rule: 'V1', detail: `${overlaps} of the last ${VIDEO_BOT_SAMPLE_SIZE - 1} video sessions overlapped in time (several sessions claimed for the same minutes)` };
    }
    const span = (last[last.length - 1].c - last[0].s) / 1000;
    const credited = last.reduce((t, x) => t + x.a, 0);
    if (credited > span + 10) {
        return { rule: 'V2', detail: `${Math.round(credited)}s of video credited in only ${Math.round(span)}s of real time (last ${VIDEO_BOT_SAMPLE_SIZE} claims)` };
    }
    return null;
                                                                              }
