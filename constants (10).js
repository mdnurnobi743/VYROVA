// lib/constants.js — SEASON 2 UPDATE (FIXED RATES — live pricing removed)
//
// ⚠️ Per admin's instruction, the live TON price system was removed — it
// would sometimes overpay users in TON when the market price dipped. Now
// it's back to simple, predetermined (fixed) rates — predictable payouts,
// no dependency on an external API.
//
// Dropped the two-tier Gold + Diamond currency — now there's a single
// currency: the VYRO COIN coin. All reward/fee/withdraw numbers live here.

// ── VYRO COIN → real-money conversion rate (FIXED) ──
export const WTC_PER_USD = 50000; // 50,000 VYRO COIN = 1 USD

// ── VYRO COIN earned by watching videos (via the floating "lootbox" button in the video section) ──
const VIDEO_WTC_PER_MINUTE = 60 / 60;    // 60 VYRO COIN/hour
export const VIDEO_WTC_PER_SECOND = VIDEO_WTC_PER_MINUTE / 60;
export const LOOTBOX_CLAIM_MIN = 25;         // minimum accrued amount required to claim
export const LOOTBOX_CLAIM_MAX = 500;        // max credit per network call (to prevent time-spoofing, not a daily cap)

// Daily video-watch time limit.
const DAILY_VIDEO_WATCH_HOURS_MAX = 5;
export const DAILY_VIDEO_WTC_MAX = DAILY_VIDEO_WATCH_HOURS_MAX * 60 * VIDEO_WTC_PER_MINUTE; // = 300 VYRO COIN/day (auto-follows VIDEO_WTC_PER_MINUTE above)

// ── The Extract tab's ad-network buttons — each pays VYRO COIN directly ──
// adsgramSpecial re-added (was removed entirely per an earlier
// admin request; now back per a newer request). Different block ID this
// time (27566, daily limit 10) than the old one that was removed. "usl"
// (USL Ads / TowerAds SDK) is live — credentials and the loadAndShow()
// integration live in index.html's showUslAd() / getTowerAdsInstance().
// See api/earn.js's handleAdStart/handleClaimAdReward, which check
// `enabled !== false` before allowing adStart/claimAdReward — kept in
// place so any network can be paused instantly by flipping its `enabled`
// flag here, without a code deploy.
// monetag reward 15 → 10 VYRO COIN (per admin request — Monetag's
// CPM runs low compared to the other networks, so the payout no longer
// matched what it was actually worth).
//
// AD_MIN_WATCH_SECONDS below used to be one shared floor for every network.
// Split into per-network `minWatchSeconds` here instead, since real ad unit
// durations differ network to network — a single shared number was always
// either too strict for the shortest network or too loose for the longest.
// AD_MIN_WATCH_SECONDS still exists as the fallback for any network that
// doesn't set its own minWatchSeconds (see handleClaimAdReward, api/earn.js).
//
// `requiresClick: true` (giga only now) — IMPORTANT — this flag is NOT yet
// enforced anywhere in api/earn.js. Implementing a real click requirement
// needs to be checked against what GigaPub's own SDK actually exposes
// (their simple rewarded-ad call doesn't appear to distinguish click vs.
// impression — only their separate, bigger "OfferWall" product does, which
// is a different integration entirely — see chat history). Flagging it here
// as a marker of INTENT so it isn't forgotten, not as something active.
//
// ⚠️ REMOVED (this update) — Monetag's server-to-server postback system
// (was handleMonetagPostback in api/earn.js, plus the ymid plumbing in
// index.html). Admin decision: reverted back to the same signed-token +
// timer heuristic every other network uses here, at a 6-second floor.
// `monetag` and `monetagPopup` are now ordinary networks again — no
// `requiresClick`, no postback, no ymid, no MONETAG_POSTBACK_SECRET needed.
export const AD_NETWORK_REWARDS = {
    // minWatchSeconds is now the REAL minimum
    // time the ad must stay open before a reward is paid (the client measures it,
    // the server also checks it — see handleClaimAdReward in api/earn.js).
    // Closing earlier than this = no reward. Per admin:
    //   Adsgram Daily 5s · Adsgram Special 10s · GigaPub 4s · USL 5s · Monetag 4s
    adsgramDaily:   { reward: 10, dailyLimit: 10, minWatchSeconds: 5 },
    adsgramSpecial: { reward: 25, dailyLimit: 10, minWatchSeconds: 10 },
    monetag:        { reward: 8,  dailyLimit: 10, minWatchSeconds: 4 },
    giga:           { reward: 15, dailyLimit: 15, minWatchSeconds: 4, requiresClick: true },
    usl:            { reward: 10, dailyLimit: 20, minWatchSeconds: 5 },
    // ⚠️ Monetag's separate "Rewarded Popup" format (show_9442539('pop') —
    // different call shape from the plain show_9442539() used by `monetag`
    // above). Back to the standard adStart/claimAdReward token flow, same
    // 6-second floor as `monetag` (both are "the Monetag family").
    monetagPopup:   { reward: 3,  dailyLimit: 5, minWatchSeconds: 6 },
};

// this export was MISSING, which is exactly why every /api/earn
// action (all 4 ad networks + video + tasks + promo, not just ads) was
// throwing a 500 today: api/earn.js imports this by name, and a missing
// named export fails the entire module's load, not just the one feature
// that uses it.
//
// Minimum seconds that must elapse between an `adStart` token being issued
// and `claimAdReward` accepting it — the server-side floor that makes the
// Termux replay-script attack impossible to instant-farm (it can still
// technically call claimAdReward after waiting this long with no ad
// actually watched, since this alone isn't full S2S ad-network
// verification — but it removes the "drain the daily limit in under a
// second" exploit, and rate-limits any adapted script to real wall-clock
// time).
// this is now only the FALLBACK for a network with no
// `minWatchSeconds` of its own in AD_NETWORK_REWARDS above (currently just
// usl and monetagPopup, plus any future network added without an explicit
// value). Kept at 15s for that fallback case.
export const AD_MIN_WATCH_SECONDS = 15;

// the client reports how long the ad was actually on
// screen (viewMs). It can never be longer than the whole adStart→claim round
// trip; this is the slack allowed for clock/rounding differences.
export const AD_VIEW_TOLERANCE_SECONDS = 1.5;

// 🎮 NEW — Games section. After GAME_PLAY_SECONDS of playing, the user can claim
// a random GAME_CLAIM_MIN..GAME_CLAIM_MAX VYRO COIN (after 1 ad), up to GAME_DAILY_CLAIMS_MAX times/day.
export const GAME_PLAY_SECONDS = 120;      // 2 minutes
export const GAME_CLAIM_MIN = 5;
export const GAME_CLAIM_MAX = 15;
export const GAME_DAILY_CLAIMS_MAX = 40;

// 🤖 NEW — Earn › VYROVA Mini Bot (games/mini-bot.html). Per finished run a player can win up to
// MINI_BOT_ENEMY_COIN_CAP (enemies) + MINI_BOT_BOSS_COIN (only if the boss was killed) = 200 VYRO COIN.
// The server re-checks every number (lib/miniBot.js) — the game only *reports* its result.
export const MINI_BOT_ENEMY_COIN_CAP = 30;
export const MINI_BOT_BOSS_COIN = 170;
export const MINI_BOT_DAILY_RUNS_MAX = 3;        // paid runs per Bangladesh day (the cap on VYRO COIN / day)
export const MINI_BOT_MIN_SECONDS_PER_COIN = 0.9; // enemy coins need real play time (30 coins ≥ 27s)
export const MINI_BOT_BOSS_MIN_SECONDS = 85;      // the boss only appears ~66s in and takes real time to kill
export const MINI_BOT_TOKEN_MAX_SECONDS = 1200;   // a run token expires 20 min after it was issued

// 🔥 NEW — Daily login streak. 7-day cycle, reward grows each consecutive
// day (index 0 = day 1), then wraps back to day 1 if the user keeps
// claiming daily. Miss a day (skip claiming for a full BD calendar day) and
// the streak resets to day 1 on the next claim. One Adsgram "init" ad
// (STREAK_AD_MIN_SECONDS) per claim.
export const STREAK_REWARDS = [10, 20, 35, 55, 80, 120, 200];

// 📅 NEW — Daily Claim (Home › "Claim +20"). 7-day reward path, paid in VYRO COIN, once per
// Bangladesh calendar day, ONLY after the user's Telegram bio is verified to contain their own
// VYROVA invite link (see lib/dailyClaim.js). Claim on consecutive days to advance (Day 1 → Day 7);
// after Day 7 the next claim starts again at Day 1; skipping a full day also restarts at Day 1.
// Kept separate from the legacy STREAK_* values above (that feature is removed/unused).
export const DAILY_CLAIM_REWARDS = [20, 40, 60, 80, 100, 120, 140];
export const DAILY_CLAIM_ATTEMPT_COOLDOWN_SECONDS = 5; // min gap between two verification attempts (protects the Telegram API + stops hammering)
export const STREAK_AD_MIN_SECONDS = 8;

// this was defined but never actually imported/used anywhere, so
// the "20-second gap between ads" it describes was NOT being enforced at
// all — pure dead code, a script could adStart→claimAdReward back-to-back
// with zero pacing. Now wired into handleClaimAdReward (see api/earn.js).
// lowered from 20s to 10s. NOTE: this was
// briefly paired with a temporary reward cut ("make each cycle worthless"
// instead of "make each cycle slow") — that reward cut has since been
// REVERTED per a later admin decision (rewards are back up, see
// AD_NETWORK_REWARDS above) once it was clear the real defense here is the
// time-gate itself (signed token + AD_MIN_WATCH_SECONDS + this cooldown),
// not the payout size. A script still can't complete an ad cycle faster
// than AD_MIN_WATCH_SECONDS + this cooldown regardless of what the reward
// is, so the two are no longer linked — reward size can move independently
// of this value going forward.
export const AD_COOLDOWN_SECONDS = 10;

// minimum real time a user must hold a task open before claiming
// it (daily/exclusive/partner/earning categories — 'channel' tasks skip this
// entirely since Telegram membership is independently verified). Kept
// slightly under the frontend's claim-button countdown so a genuine user
// is never blocked by their own honest usage; a script that skips straight
// from taskStart to taskComplete with no real wait gets rejected. See
// handleTaskStart/handleTaskComplete in api/earn.js.
// was 8 (paired with a 10s frontend countdown). Frontend
// countdown is now 5s (per admin request), so this had to come down too —
// left as-is it would have been LONGER than the countdown itself, meaning
// every honest user who claimed right at 5s would get rejected server-side.
export const TASK_MIN_WAIT_SECONDS = 4;

// cooldown between ANY two non-channel task completions by the same
// user, regardless of which task. TASK_MIN_WAIT_SECONDS above only limits how
// fast a SINGLE task can be claimed after it's started — it does nothing to
// stop a script from finishing task #1, then instantly taskStart→claim on
// task #2, #3, #4... in a chain, draining every open task in well under a
// minute. This mirrors AD_COOLDOWN_SECONDS (which already does exactly this
// for ad claims) but was missing here entirely. Deliberately NOT touching
// TASK_MIN_WAIT_SECONDS or the frontend's 5s countdown — those were a
// considered admin UX decision; this is a separate, additive gate that
// doesn't change how fast a real user's first task feels, only how fast
// they could chain many.
// was 15s (admin feedback: real users doing several tasks in a
// row would feel this as friction and drop off). Lowered to 8s — still long
// enough that a script can't drain a stack of tasks in the same handful of
// seconds it takes to be worth automating, but short enough that nobody
// genuinely browsing tasks back-to-back gets stopped waiting on it. This
// gate ONLY applies to non-channel tasks (see taskStartKey in
// handleTaskComplete, api/earn.js) — 'channel'/api-verified tasks (Telegram
// membership check) are never subject to this cooldown at all, exactly as
// requested: verification-based tasks stay instant, only the un-verifiable
// link/article/faucet-style tasks get this pacing.
export const TASK_COOLDOWN_SECONDS = 8;

// ── Withdraw methods ──
// ⚠️ TON withdrawal removed — Tonkeeper is now used only as a wallet ADDRESS
// (users still paste their TON wallet/Tonkeeper address), but the actual
// payout sent to that address is USDT (USDT-on-TON), not native TON coin.
// Both methods now pay out in USDT.
export const WITHDRAW_METHODS = {
    binance:   { label: 'Binance UID',       currency: 'USDT', minCurrency: 0.1, wtcToCurrency: (wtc) => wtc / WTC_PER_USD },
    tonkeeper: { label: 'Tonkeeper Address', currency: 'USDT', minCurrency: 0.1, wtcToCurrency: (wtc) => wtc / WTC_PER_USD },
};

// Wallet lock. A user's FIRST withdrawal method + address become their permanent
// wallet (user.lockedWalletMethod / user.lockedWalletAddress); every later
// withdrawal reuses it and the client's method/details are ignored (so a tampered
// client can't redirect a payout).
//
// If the address was wrong, the "Wrong Address" flow (wd_fixaddr_ / wd_new_address
// in api/bot.js) lets the user set a NEW permanent wallet — only ONCE ever
// (user.walletChangeUsed). It closes the current pending withdrawal as a refund
// minus this penalty percentage. After that, a wrong-address report can only be
// closed with the 50% penalty confirm (wd_addrconfirm_), which does not change the wallet.
export const WALLET_CHANGE_PENALTY_PERCENT = 5;

// ── Withdraw ──
// One step: the user types a VYRO COIN amount (minimum MIN_WITHDRAW_WTC) and submits.
//
// Two fees are applied back to back (see calcNetUsd in api/withdraw.js and
// calcNetUsdDisplay in index.html): fee 1, then fee 2 on what is left.
// Currently 15% + 0%, so the user nets 85% of face value.
export const MIN_WITHDRAW_WTC = 1500;

// The first FREE_WITHDRAWALS_BEFORE_REFERRAL_GATE withdrawals need no valid referral,
// but each one is capped at this amount (gross, before fees).
export const FREE_WITHDRAW_MAX_USD = 0.25;
export const FREE_WITHDRAW_MAX_WTC = Math.floor(FREE_WITHDRAW_MAX_USD * WTC_PER_USD);

export const WITHDRAW_FEE_PERCENT = 15;
export const WITHDRAW_SECOND_FEE_PERCENT = 0;  // 0 = only one fee

// Daily gate: checked against adsWatchedToday, which resets at Bangladesh midnight
// (see todayBD() / dailyResetFields() below).
export const WITHDRAW_ADS_REQUIRED = 0; // ads removed — no ad requirement for withdrawals

// Anti-farming account-age gate: hours a user must have existed (user.createdAt) before
// their FIRST withdrawal. Later withdrawals are not re-gated. 0 = gate disabled
// everywhere (modal, status endpoint and create endpoint all read this one number).
export const WITHDRAW_MIN_ACCOUNT_AGE_HOURS = 0;

// Promised payout window shown to users. DISPLAY ONLY — nothing auto-approves or
// auto-rejects; approval is the admin's manual flow in api/bot.js.
// Keep index.html's WITHDRAW_PROCESS_*_DISPLAY in sync with these two.
export const WITHDRAW_PROCESS_MIN_HOURS = 3;
export const WITHDRAW_PROCESS_MAX_HOURS = 48;

// Terms & Conditions gate. Every user must accept the current terms once
// (api/user.js action:'acceptTerms' → users.termsVersion) before earning or withdrawing;
// api/earn.js and api/withdraw.js answer 'terms_required' until then. Bump TERMS_VERSION
// when the terms change materially. Keep index.html's TERMS_VERSION_DISPLAY in sync.
export const TERMS_VERSION = 1;
// true  = accounts that already existed must ALSO accept the terms the next time they open the app.
// false = only new accounts are asked; older accounts are marked accepted (grandfathered).
export const TERMS_APPLY_TO_EXISTING_USERS = true;

// Referral rules for withdrawals:
//   • The first FREE_WITHDRAWALS_BEFORE_REFERRAL_GATE withdrawals need NO valid referral,
//     but each is capped at FREE_WITHDRAW_MAX_USD (gross, before fees).
//   • After that, one valid referral is needed per WITHDRAW_USD_PER_VALID_REFERRAL
//     (or part of it) withdrawn — see requiredReferralsForUsd().
// A referral becomes "valid" once the referred user completes all referral milestones
// (lib/referral.js). Enforced in api/withdraw.js against user.validReferralCount - user.usedValidReferrals.
export const FREE_WITHDRAWALS_BEFORE_REFERRAL_GATE = 5;
export const WITHDRAW_USD_PER_VALID_REFERRAL = 0.25;
export function requiredReferralsForUsd(usd) {
    return Math.max(1, Math.ceil(usd / WITHDRAW_USD_PER_VALID_REFERRAL));
}


// withdraw address is never locked. Left the constant name out of the file
// entirely rather than a disabled flag, since nothing should reference it
// ── Referral — given in 4 stages (lifetime milestone, awarded once) ──
// Referral milestone rewards — each is paid once, to the REFERRER (lifetime milestone).
// Total per friend: 30 + 100 + 180 + 90 + 100 = 500 VYRO COIN. Step 4 is awarded the first time the
// referred user claims a lootbox in the Video section (handleClaimLootbox in api/earn.js,
// maybeAwardReferralMilestones in lib/referral.js).
export const REFERRAL_REWARDS = {
    step1_verified:      30,  // when the referred user joins channel+community and verifies
    step2_tenTasks:      100, // when the referred user completes 10 tasks
    step3_twentyAds:     180, // when the referred user completes 20 ads (key name kept as-is)
    step4_firstLootbox:  90,  // when the referred user claims their first Video-section lootbox
    step5_twentySpins:   100, // when the referred user completes 20 spins (lifetime)
};
export const REFERRAL_STEP2_TASK_COUNT = 5;
export const REFERRAL_STEP5_SPIN_COUNT = 20; // spins the referred user must do for the step-5 bonus
export const REFERRAL_STEP3_AD_COUNT = 20;

// referral SIGNUP velocity lock. This is a much earlier tripwire
// than the milestone cap above — it fires at the moment of SIGNUP
// attribution (before any milestone, any reward), based on a simple truth:
// no real promotion — not even a big channel post — delivers signups this
// fast. People have to see the message, tap the link, open Telegram, and
// go through onboarding; that takes minutes to hours to spread, even
// virally. REFERRAL_VELOCITY_THRESHOLD+ signups under one referrer within
// REFERRAL_VELOCITY_WINDOW_MS is not organic growth, full stop — auto-lock
// first, let the admin review and decide (unlock or ban) after the fact.
export const REFERRAL_VELOCITY_WINDOW_MS = 2 * 60 * 1000; // 2 minutes
export const REFERRAL_VELOCITY_THRESHOLD = 20;             // 20+ signups inside that window

// raw-IP signup velocity lock. This is the direct fix for the
// "90 fresh accounts in 3 minutes, one-click script, instant withdraw"
// pattern: the device-fingerprint gate in lib/ipRegistry.js only stops a
// SECOND account on the same device, but a script isn't a real browser —
// it can send a different fake fingerprint string on every request and
// that gate never even sees a repeat. What it CANNOT easily fake is the
// actual TCP/HTTP client IP hitting our server. Even under Bangladeshi
// carrier CGNAT where many unrelated phones share one public IP, no
// organic mix of real people happens to register in a tight burst like
// this — that's a farm script looping, full stop.
// Deliberately keyed on raw IP (not the fingerprint-or-IP `registryKey`
// used for the one-account-per-device gate) — this is a SEPARATE signal:
// device gate = "not the same phone as an existing account", this =
// "too many brand-new accounts appearing from one network path too fast".
// Threshold set well above plausible shared-IP coincidence (a cyber-café
// or office NAT seeing 2-3 signups in a burst is normal; 6+ in under 3
// minutes is not) — tune IP_SIGNUP_VELOCITY_THRESHOLD up if a genuine
// shared-IP false positive shows up in admin review.
export const IP_SIGNUP_VELOCITY_WINDOW_MS = 3 * 60 * 1000; // 3 minutes
export const IP_SIGNUP_VELOCITY_THRESHOLD = 6;              // 6+ new accounts from one IP inside that window

// withdrawal referral commission. Every time a user withdraws, if
// they were referred by someone, the referrer is credited this % of the
// WITHDRAWN VYRO COIN AMOUNT (gross, before withdraw fees) directly to their own
// wtcBalance — e.g. a 1,000 VYRO COIN withdrawal pays the referrer 100 VYRO COIN. This
// is NOT a one-time reward — it fires on every withdrawal, indefinitely, for
// as long as the referral relationship exists. See api/withdraw.js.
export const WITHDRAW_REFERRAL_COMMISSION_PERCENT = 10;

// ⚠️ REMOVED (update) — "Punch Key" (buy a valid referral with TON) is gone.

// ══════════════════════════════════════════════════════════
// USER-CREATED TASKS ("Create Task" button, Task tab). A user pays
// TON to publish their OWN task — either a channel/group join (API-
// verified via the bot's own membership check, same mechanism as any other
// verifyType:'api' task) or a link to anything else (another bot, a
// website — verifyType:'link', manual claim-after-wait like every other
// non-API task). It's inserted into the SAME `tasks` collection admin-
// created tasks live in, category:'exclusive', so the existing Task tab
// rendering + claim flow (api/earn.js handleTaskStart/handleTaskComplete)
// needs ZERO changes to serve these — `limit`/`completionCount` already
// gate a capped task atomically. See api/payments.js (resource:'taskcreate') +
// api/payments.js (cron=checkDeposits). On-chain TON-deposit pattern (memo-matched, atomically credited, external cron).
export const TASK_CREATE_REWARD_PER_TASK_WTC = 10; // every completion of a user-created task pays this many VYRO COIN, fixed
export const TASK_CREATE_PACKAGES = {
    100:  { taskCount: 100,  priceNanoTon: 150_000_000 },    // 0.15 TON
    200:  { taskCount: 200,  priceNanoTon: 300_000_000 },    // 0.30 TON
    500:  { taskCount: 500,  priceNanoTon: 750_000_000 },    // 0.75 TON
    1000: { taskCount: 1000, priceNanoTon: 1_500_000_000 },  // 1.5 TON
};
export const TASK_CREATE_ORDER_EXPIRY_MINUTES = 15; // client mirror: TASK_CREATE_ORDER_EXPIRY_MIN_DISPLAY in index.html

// ═══════════════════════════════════════════════════════════
// WITHDRAWALS
// ═══════════════════════════════════════════════════════════
export const WITHDRAWALS_OPEN = true; // set false to pause all withdrawals

// ═══════════════════════════════════════════════════════════
// SPIN WHEEL
// ═══════════════════════════════════════════════════════════
// Order MUST match SPIN_SEGMENTS_DISPLAY in index.html (8 slices, 45deg each).
// ⚠️ weights are reward odds — adjust to your economy.
export const SPIN_SEGMENTS = [
    { value: 100, weight: 1  },
    { value: 10,  weight: 30 },
    { value: 20,  weight: 25 },
    { value: 30,  weight: 18 },
    { value: 40,  weight: 12 },
    { value: 50,  weight: 8  },
    { value: 60,  weight: 4  },
    { value: 80,  weight: 2  },
];
export const SPIN_FREE_COOLDOWN_HOURS = 2;      // client mirror: SPIN_FREE_COOLDOWN_HOURS_DISPLAY
export const SPIN_MIN_GAP_SECONDS = 2 * 60 * 60; // 1 spin per 2h total (free or bonus)
export const BONUS_SPINS_MAX_PER_DAY = 3;
export const SPIN_LOG_RETENTION_DAYS = 30;       // matches spinLogs TTL (api/admin/setup-indexes.js)
export const SPIN_BLOCK_ALERT_COUNT = 5;                    // blocked attempts ...
export const SPIN_BLOCK_ALERT_WINDOW_MS = 10 * 60 * 1000;   // ... within 10 min -> admin alert
export const SPIN_BOT_MIN_SPINS = 5;
export const SPIN_BOT_MAX_GAP_MS = 2 * 60 * 60 * 1000 + 10 * 60 * 1000; // 2h10m
export const SPIN_BOT_MAX_SPREAD_MS = 5000;                 // gaps differ by <=5s -> bot-like

// ═══════════════════════════════════════════════════════════
// WEEKLY REFERRAL COMPETITION
// ═══════════════════════════════════════════════════════════
export const WEEKLY_REFERRAL_MIN_COUNT = 10;  // ⚠️ adjust
export const WEEKLY_REFERRAL_MAX_WINNERS = 10;

// ═══════════════════════════════════════════════════════════
// BANGLADESH TIME HELPERS (UTC+6, no DST)
// ═══════════════════════════════════════════════════════════
const BD_OFFSET_MS = 6 * 60 * 60 * 1000;

// "MM/DD/YYYY" in Bangladesh time — format stored in users.lastResetDate
export function todayBD() {
    const d = new Date(Date.now() + BD_OFFSET_MS);
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${mm}/${dd}/${d.getUTCFullYear()}`;
}

// Date object for today's 00:00 in Bangladesh time
export function todayStartBD() {
    const bd = new Date(Date.now() + BD_OFFSET_MS);
    return new Date(Date.UTC(bd.getUTCFullYear(), bd.getUTCMonth(), bd.getUTCDate()) - BD_OFFSET_MS);
}

export function fmtBDDate(date) {
    if (!date) return '?';
    return new Date(date).toLocaleDateString('en-GB', { timeZone: 'Asia/Dhaka', day: '2-digit', month: 'short', year: 'numeric' });
}
export function fmtBDDateTime(date) {
    if (!date) return '?';
    return new Date(date).toLocaleString('en-GB', { timeZone: 'Asia/Dhaka', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
}

// Fields reset at Bangladesh midnight (used by lib/dailyReset.js)
export function dailyResetFields() {
    return {
        adsWatchedToday: 0,
        adsgramDailyCountToday: 0,
        adsgramSpecialCountToday: 0,
        monetagCountToday: 0,
        gigaCountToday: 0,
        uslCountToday: 0,
        monetagPopupCountToday: 0,
        usedAdStarts: [],
        usedLootboxStarts: [],
        usedTaskStarts: [],
        usedSpinStarts: [],
        dailyVideoWtcMined: 0,
        gameClaimsToday: 0,
        miniBotRunsToday: 0,
        usedMiniBotStarts: [],
        tasksCompletedToday: 0,
        bonusSpinsUsedToday: 0,
        lastResetDate: todayBD(),
    };
}

// ═══════════════════════════════════════════════════════════
// ARROW PUZZLE (games/arrow-puzzle.html) — enforced by lib/arrowPuzzle.js, never by the client
// ═══════════════════════════════════════════════════════════
export const ARROW_MAX_DAILY = 3;                    // attempts per Bangladesh day (an attempt counts when it STARTS)
export const ARROW_COOLDOWN_MS = 60 * 60 * 1000;     // ≥ 1 hour between the START of one attempt and the next
export const ARROW_LIVES = 1;                        // a replayed win must have fewer mistakes than this (i.e. 0)
export const ARROW_LEVELS = 100;
export const ARROW_REWARD_PER_AD = 15;               // VYRO COIN per verified ad step
export const ARROW_REWARD_TOTAL = 30;                // 2 × 15 per cleared level, hard ceiling
export const ARROW_MIN_MS_PER_MOVE = 50;             // a win faster than this per tap is not humanly plausible
