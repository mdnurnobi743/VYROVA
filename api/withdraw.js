// api/withdraw.js — single-step withdraw.
//
// The user types a WTC amount (min MIN_WITHDRAW_WTC), picks a method
// (Binance UID / Tonkeeper) and submits.
//
// Fees (lib/constants.js): WITHDRAW_FEE_PERCENT, then WITHDRAW_SECOND_FEE_PERCENT
// on the remainder (currently 15% and 0%, so the user nets 85% of face value).
// See calcNetUsd().
//
// Requirements, all from lib/constants.js:
//   • WITHDRAW_TASKS_REQUIRED lifetime tasks (one-time)
//   • WITHDRAW_ADS_REQUIRED ads in today's window
//   • WITHDRAW_SPINS_REQUIRED spins (consumed by every withdrawal, refunded on reject)
//   • account age gate on the first withdrawal (WITHDRAW_MIN_ACCOUNT_AGE_HOURS, 0 = off)
//   • accepted Terms & Conditions
//
// Referral gate: the first FREE_WITHDRAWALS_BEFORE_REFERRAL_GATE withdrawals need
// no valid referral but are capped at FREE_WITHDRAW_MAX_USD each. After that,
// valid referrals are required (1 per WITHDRAW_USD_PER_VALID_REFERRAL).
// See lib/referral.js for how a referral becomes valid.
//
// Wallet lock: the method + address of the first withdrawal become the user's
// permanent wallet. Later requests ignore whatever the client sends and use the
// locked wallet. The only way to change it is the one-time wrong-address flow
// in api/bot.js.
//
//   GET  /api/withdraw?action=status&initData=...   → balance + full eligibility snapshot
//   GET  /api/withdraw?action=history&initData=...
//   POST /api/withdraw   body: { initData, method, details, wtcAmount }

import { connectToDatabase } from '../lib/mongodb.js';
import { tgSend, escHtml } from '../lib/telegram.js';
import { ensureDailyReset } from '../lib/dailyReset.js';
import { verifyTelegramInitData } from '../lib/telegramAuth.js';
import {
    WITHDRAW_METHODS, WITHDRAW_FEE_PERCENT, WITHDRAW_SECOND_FEE_PERCENT, MIN_WITHDRAW_WTC,
    FREE_WITHDRAW_MAX_WTC, FREE_WITHDRAW_MAX_USD, FREE_WITHDRAWALS_BEFORE_REFERRAL_GATE, WITHDRAW_SPINS_REQUIRED,
    WITHDRAW_TASKS_REQUIRED, WITHDRAW_ADS_REQUIRED, requiredReferralsForUsd, WITHDRAW_USD_PER_VALID_REFERRAL,
    WITHDRAW_MIN_ACCOUNT_AGE_HOURS,
    WITHDRAW_PROCESS_MIN_HOURS, WITHDRAW_PROCESS_MAX_HOURS, TERMS_VERSION,
    todayBD, fmtBDDateTime, WTC_PER_USD, WITHDRAWALS_OPEN,
} from '../lib/constants.js';

const MIN_ACCOUNT_AGE_MS = WITHDRAW_MIN_ACCOUNT_AGE_HOURS * 60 * 60 * 1000;

// Hours remaining until user.createdAt + WITHDRAW_MIN_ACCOUNT_AGE_HOURS. 0 once eligible.
function accountAgeHoursRemaining(user) {
    const createdAt = user.createdAt ? new Date(user.createdAt).getTime() : 0;
    const eligibleAt = createdAt + MIN_ACCOUNT_AGE_MS;
    return Math.max(0, Math.ceil((eligibleAt - Date.now()) / (60 * 60 * 1000)));
}

const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID;

// Binance UIDs are digits, Tonkeeper/TON addresses are base64url or raw "0:hex".
// No whitespace and no HTML characters; the length bounds only stop junk — the
// admin's "Wrong Address" button handles addresses that are well-formed but wrong.
const WALLET_DETAILS_RE = /^[A-Za-z0-9_\-:.+\/=]{5,100}$/;

// wtcAmount → net USDT the user actually receives, after both fees are applied
// one after the other (second fee is taken on what is left after the first).
function calcNetUsd(wtcAmount) {
    const grossUsd = wtcAmount / WTC_PER_USD;
    const afterFirstFee = grossUsd * (1 - WITHDRAW_FEE_PERCENT / 100);
    const netUsd = afterFirstFee * (1 - WITHDRAW_SECOND_FEE_PERCENT / 100);
    return { grossUsd, netUsd };
}

// ── GET ?action=status — everything the withdraw screen needs in one call ──
async function handleStatus(req, res, db) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    const verified = verifyTelegramInitData(req.query.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const id = String(verified.user.id);

    const users = db.collection('users');
    const today = await ensureDailyReset(users, id);
    const user = await users.findOne({ _id: id });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });

    const adsToday = user.lastResetDate === today ? (user.adsWatchedToday || 0) : 0;
    const tasksLifetime = (user.completedTasks || []).length;
    const isFirstWithdraw = (user.withdrawalCount || 0) === 0;
    // the first N withdrawals are referral-free (capped); the gate activates after that.
    const withdrawalsDone = user.withdrawalCount || 0;
    const isFreePhase = withdrawalsDone < FREE_WITHDRAWALS_BEFORE_REFERRAL_GATE;
    const spinsHave = Math.max(0, user.spinsSinceWithdraw || 0);
    const validAvailable = Math.max(0, (user.validReferralCount || 0) - (user.usedValidReferrals || 0));
    // account-age gate only applies to the first withdrawal ever (see
    // WITHDRAW_MIN_ACCOUNT_AGE_HOURS in lib/constants.js for why).
    const hoursRemaining = isFirstWithdraw ? accountAgeHoursRemaining(user) : 0;

    return res.status(200).json({
        ok: true,
        wtcBalance: user.wtcBalance || 0,
        minWithdrawWtc: MIN_WITHDRAW_WTC,
        feePercent: WITHDRAW_FEE_PERCENT,
        secondFeePercent: WITHDRAW_SECOND_FEE_PERCENT,
        withdrawalsOpen: WITHDRAWALS_OPEN,
        // Promised payout window (display only) and Terms & Conditions status.
        processingHours: { min: WITHDRAW_PROCESS_MIN_HOURS, max: WITHDRAW_PROCESS_MAX_HOURS },
        termsAccepted: user.termsVersion === TERMS_VERSION,
        // Wallet lock (see WALLET_CHANGE_PENALTY_PERCENT, lib/constants.js).
        // null = no withdrawal yet; the form is shown and the wallet locks on first submit.
        withdrawPending: !!user.withdrawPending,
        lockedWallet: (user.lockedWalletMethod && user.lockedWalletAddress)
            ? { method: user.lockedWalletMethod, address: user.lockedWalletAddress }
            : null,
        withdrawRequirements: {
            adsRequired: WITHDRAW_ADS_REQUIRED, adsWatchedToday: adsToday, adsMet: adsToday >= WITHDRAW_ADS_REQUIRED,
            tasksRequired: WITHDRAW_TASKS_REQUIRED, tasksHave: tasksLifetime, tasksMet: tasksLifetime >= WITHDRAW_TASKS_REQUIRED,
            spinsRequired: WITHDRAW_SPINS_REQUIRED, spinsHave, spinsMet: spinsHave >= WITHDRAW_SPINS_REQUIRED,
            accountAgeRequiredHours: isFirstWithdraw ? WITHDRAW_MIN_ACCOUNT_AGE_HOURS : 0,
            accountAgeHoursRemaining: hoursRemaining,
            accountAgeMet: hoursRemaining === 0,
        },
        referralRequirement: {
            isFirstWithdrawFree: isFirstWithdraw, // kept for older clients
            isFreePhase,
            freeWithdrawalsTotal: FREE_WITHDRAWALS_BEFORE_REFERRAL_GATE,
            freeWithdrawalsLeft: Math.max(0, FREE_WITHDRAWALS_BEFORE_REFERRAL_GATE - withdrawalsDone),
            freeWithdrawMaxUsd: FREE_WITHDRAW_MAX_USD,
            freeWithdrawMaxWtc: FREE_WITHDRAW_MAX_WTC,
            // frontend can show this cap upfront instead of letting
            // the user submit and only then find out their free first
            // withdrawal is capped.
            firstWithdrawMaxWtc: isFreePhase ? FREE_WITHDRAW_MAX_WTC : null,
            // replaces the old flat `perWithdraw: 1`. Referrals
            // needed now scale with the withdrawal amount (see
            // requiredReferralsForUsd, lib/constants.js) — not known until
            // the user types an amount, so the RATE is reported instead;
            // frontend computes Math.ceil(enteredUsd / usdPerReferral) live.
            usdPerReferral: WITHDRAW_USD_PER_VALID_REFERRAL,
            validReferralsAvailable: validAvailable,
            needsReferral: !isFreePhase,
            // Baseline-only — "do they have at least 1", not the final
            // check for whatever amount they end up entering. handleCreate
            // re-verifies the real, amount-based requirement at submit time.
            met: isFreePhase || validAvailable >= 1,
        },
    });
}

// ── GET ?action=history ──
async function handleHistory(req, res, db) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    const verified = verifyTelegramInitData(req.query.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const id = String(verified.user.id);

    const withdrawals = db.collection('withdrawals');
    const list = await withdrawals
        .find({ userId: id, status: { $in: ['pending', 'approved'] } })
        .sort({ createdAt: -1 })
        .limit(30)
        .project({ userId: 0, username: 0 })
        .toArray();

    return res.status(200).json({ ok: true, history: list });
}

// ── POST — single-step withdraw create ──
async function handleCreate(req, res, db) {
    if (!WITHDRAWALS_OPEN) {
        return res.status(403).json({ ok: false, error: 'withdrawals_closed', message: 'Withdrawals are currently closed. Any previously submitted request will still be processed.' });
    }

    const verified = verifyTelegramInitData(req.body?.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const id = String(verified.user.id);

    let { method, details } = req.body || {};
    const wtcAmount = Math.floor(Number(req.body?.wtcAmount));

    if (!Number.isFinite(wtcAmount) || wtcAmount <= 0) return res.status(400).json({ ok: false, error: 'invalid_amount' });
    if (wtcAmount < MIN_WITHDRAW_WTC) {
        return res.status(400).json({
            ok: false, error: 'below_minimum',
            message: `Minimum ${MIN_WITHDRAW_WTC.toLocaleString()} WTC required to withdraw.`,
        });
    }

    const users = db.collection('users');
    const today = await ensureDailyReset(users, id);
    const user = await users.findOne({ _id: id });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
    if (user.isBanned) return res.status(403).json({ ok: false, error: 'banned' });
    // must have accepted the Terms & Conditions first.
    if (user.termsVersion !== TERMS_VERSION) return res.status(403).json({ ok: false, error: 'terms_required' });

    // ── wallet lock (see WALLET_CHANGE_PENALTY_PERCENT, lib/constants.js) ──
    const hasLockedWallet = !!(user.lockedWalletMethod && user.lockedWalletAddress);
    if (hasLockedWallet) {
        // Ignore whatever the client sent — always use the locked wallet, so a
        // tampered/stale client can't redirect a payout to another address.
        method = user.lockedWalletMethod;
        details = user.lockedWalletAddress;
    } else {
        // First-ever withdrawal: method + address come from the client this one
        // time and get locked in below once the request succeeds.
        if (!method || !details) return res.status(400).json({ ok: false, error: 'missing_fields' });
        details = typeof details === 'string' ? details.trim() : '';
        if (!WALLET_DETAILS_RE.test(details)) {
            return res.status(400).json({ ok: false, error: 'invalid_address', message: 'That address/UID does not look valid. Check it and try again.' });
        }
    }

    // hasOwn: plain WITHDRAW_METHODS[method] would also accept "__proto__" / "constructor".
    if (typeof method !== 'string' || !Object.hasOwn(WITHDRAW_METHODS, method)) {
        return res.status(400).json({ ok: false, error: 'invalid_method' });
    }
    const methodConfig = WITHDRAW_METHODS[method];
    // Referral-velocity auto-lock (lib/constants.js REFERRAL_VELOCITY_*, set in
    // api/user.js): softer than a ban — balance stays, withdrawals are held
    // until an admin reviews and either unlocks or bans.
    if (user.accountLocked) {
        return res.status(403).json({
            ok: false, error: 'account_locked',
            message: 'Your account is temporarily locked for review. Please contact support.',
        });
    }

    // ── lifetime tasks requirement (one-time, not daily) ──
    const tasksLifetime = (user.completedTasks || []).length;
    if (tasksLifetime < WITHDRAW_TASKS_REQUIRED) {
        return res.status(400).json({
            ok: false, error: 'need_tasks',
            tasksRequired: WITHDRAW_TASKS_REQUIRED, tasksHave: tasksLifetime,
            message: `Complete at least ${WITHDRAW_TASKS_REQUIRED} tasks (lifetime, one-time) before you can withdraw (you have ${tasksLifetime} done).`,
        });
    }

    // ── spins requirement (per withdrawal) ──
    const spinsHave = Math.max(0, user.spinsSinceWithdraw || 0);
    if (spinsHave < WITHDRAW_SPINS_REQUIRED) {
        return res.status(400).json({
            ok: false, error: 'need_spins',
            spinsRequired: WITHDRAW_SPINS_REQUIRED, spinsHave,
            message: `Do ${WITHDRAW_SPINS_REQUIRED} spins before every withdrawal (you have ${spinsHave}).`,
        });
    }

    // ── account-age requirement (first withdrawal only; 0 hours = disabled) ──
    // Blocks "join → script farms tasks/ads in minutes → instant withdraw".
    // See WITHDRAW_MIN_ACCOUNT_AGE_HOURS in lib/constants.js.
    const isFirstWithdrawForAgeCheck = (user.withdrawalCount || 0) === 0;
    if (isFirstWithdrawForAgeCheck) {
        const hoursRemaining = accountAgeHoursRemaining(user);
        if (hoursRemaining > 0) {
            return res.status(400).json({
                ok: false, error: 'account_too_new',
                accountAgeRequiredHours: WITHDRAW_MIN_ACCOUNT_AGE_HOURS, accountAgeHoursRemaining: hoursRemaining,
                message: `Your account must be at least ${WITHDRAW_MIN_ACCOUNT_AGE_HOURS} hours old before your first withdrawal. Please wait ${hoursRemaining} more hour${hoursRemaining === 1 ? '' : 's'}.`,
            });
        }
    }

    // ── daily ads requirement ──
    const adsToday = user.lastResetDate === today ? (user.adsWatchedToday || 0) : 0;
    if (adsToday < WITHDRAW_ADS_REQUIRED) {
        return res.status(400).json({
            ok: false, error: 'insufficient_ads',
            adsRequired: WITHDRAW_ADS_REQUIRED, adsToday,
            message: `Watch ${WITHDRAW_ADS_REQUIRED} ads today before withdrawing (you have ${adsToday} today).`,
        });
    }

    // ── balance ──
    if ((user.wtcBalance || 0) < wtcAmount) {
        return res.status(400).json({ ok: false, error: 'insufficient_balance', message: `You need ${wtcAmount.toLocaleString()} WTC to withdraw this amount.` });
    }

    // ── referral gate ──
    // The first FREE_WITHDRAWALS_BEFORE_REFERRAL_GATE withdrawals need no valid
    // referral but are capped at FREE_WITHDRAW_MAX_WTC (gross, before fees).
    // After that, valid referrals are required in proportion to the amount.
    const isFirstWithdraw = (user.withdrawalCount || 0) === 0;
    const isFreePhase = (user.withdrawalCount || 0) < FREE_WITHDRAWALS_BEFORE_REFERRAL_GATE;
    const willConsumeReferral = !isFreePhase;
    if (isFreePhase && wtcAmount > FREE_WITHDRAW_MAX_WTC) {
        return res.status(400).json({
            ok: false, error: 'first_withdraw_cap',
            firstWithdrawMaxWtc: FREE_WITHDRAW_MAX_WTC, firstWithdrawMaxUsd: FREE_WITHDRAW_MAX_USD,
            message: `Maximum withdrawal is ${FREE_WITHDRAW_MAX_WTC.toLocaleString()} WTC ($${FREE_WITHDRAW_MAX_USD}) per withdrawal for your first ${FREE_WITHDRAWALS_BEFORE_REFERRAL_GATE} withdrawals. Lower the amount.`,
        });
    }
    const { grossUsd, netUsd } = calcNetUsd(wtcAmount);
    const referralsNeeded = willConsumeReferral ? requiredReferralsForUsd(grossUsd) : 0;
    const validAvailable = Math.max(0, (user.validReferralCount || 0) - (user.usedValidReferrals || 0));
    if (willConsumeReferral && validAvailable < referralsNeeded) {
        return res.status(400).json({
            ok: false, error: 'referral_required',
            validReferralsAvailable: validAvailable, validReferralsNeeded: referralsNeeded,
            message: `After ${FREE_WITHDRAWALS_BEFORE_REFERRAL_GATE} withdrawals, valid referrals are required: 1 per every $${WITHDRAW_USD_PER_VALID_REFERRAL} withdrawn. This withdrawal needs ${referralsNeeded}, you have ${validAvailable}. Invite friends and wait for them to complete all referral steps.`,
        });
    }

    // Used to undo the gate update below if saving the request fails afterwards.
    const undoOps = {
        $inc: { wtcBalance: wtcAmount, withdrawalCount: -1, spinsSinceWithdraw: WITHDRAW_SPINS_REQUIRED },
        $set: { withdrawPending: false },
    };
    if (willConsumeReferral) undoOps.$inc.usedValidReferrals = -referralsNeeded;
    if (!hasLockedWallet) undoOps.$unset = { lockedWalletMethod: '', lockedWalletAddress: '' };

    const updateOps = {
        $inc: { wtcBalance: -wtcAmount, withdrawalCount: 1, spinsSinceWithdraw: -WITHDRAW_SPINS_REQUIRED },
        $set: { withdrawPending: true },
    };
    if (willConsumeReferral) updateOps.$inc.usedValidReferrals = referralsNeeded;
    // Lock the wallet in on the first successful withdrawal.
    if (!hasLockedWallet) {
        updateOps.$set.lockedWalletMethod = method;
        updateOps.$set.lockedWalletAddress = details;
    }

    // ── ATOMIC GATE ──
    // Balance, today's-reset boundary, ads, tasks, spins, pending flag and
    // referral availability are all re-verified in this single update, so a
    // double-tap or a Bangladesh-midnight reset between the reads above and
    // this write cannot slip a withdrawal through.
    const gate = await users.findOneAndUpdate(
        {
            _id: id,
            isBanned: { $ne: true },
            wtcBalance: { $gte: wtcAmount },
            lastResetDate: today,
            adsWatchedToday: { $gte: WITHDRAW_ADS_REQUIRED },
            withdrawPending: { $ne: true },
            $expr: {
                $and: [
                    { $gte: [{ $size: { $ifNull: ['$completedTasks', []] } }, WITHDRAW_TASKS_REQUIRED] },
                    { $gte: [{ $ifNull: ['$spinsSinceWithdraw', 0] }, WITHDRAW_SPINS_REQUIRED] },
                    ...(willConsumeReferral ? [{
                        $gte: [
                            { $subtract: [{ $ifNull: ['$validReferralCount', 0] }, { $ifNull: ['$usedValidReferrals', 0] }] },
                            referralsNeeded,
                        ],
                    }] : []),
                    // account-age gate: first withdrawal only (re-verified atomically)
                    ...(isFirstWithdraw ? [{ $lte: [{ $toLong: '$createdAt' }, Date.now() - MIN_ACCOUNT_AGE_MS] }] : []),
                ],
            },
        },
        updateOps,
        { returnDocument: 'after' }
    );

    if (!gate) {
        const stillPending = await users.findOne({ _id: id }, { projection: { withdrawPending: 1 } });
        if (stillPending?.withdrawPending) {
            return res.status(409).json({
                ok: false, error: 'withdraw_already_pending',
                message: 'You already have a withdrawal request being processed. Please wait for it to be approved or rejected before submitting another.',
            });
        }
        return res.status(409).json({
            ok: false, error: 'gate_failed',
            message: 'Could not process the withdrawal — your balance, ad/task progress, or referral status may have changed. Please refresh and try again.',
        });
    }

    const withdrawals = db.collection('withdrawals');
    const withdrawDoc = {
        userId: id,
        username: verified.user.username || null,
        method,
        details,
        wtcAmount,
        grossUsd,
        cashAmount: netUsd,          // api/bot.js reads this name in the admin/approve/reject messages
        currency: methodConfig.currency,
        // How many valid referrals this withdrawal used (0 = none). Refunded on reject.
        referralConsumed: willConsumeReferral ? referralsNeeded : 0,
        spinsConsumed: WITHDRAW_SPINS_REQUIRED, // refunded by api/bot.js if the withdrawal is rejected
        status: 'pending',
        createdAt: new Date(),
        // Recorded now for the audit trail; the commission itself is only paid
        // on approval (see finalizeWithdrawal in api/bot.js).
        referrerId: user.referredBy || null,
        referrerCommissionPaid: 0,
    };
    // Previous withdrawal (looked up BEFORE inserting this one) for the admin message.
    const prevWithdraw = await withdrawals.find({ userId: id }).sort({ createdAt: -1 }).limit(1).next();
    let inserted;
    try {
        inserted = await withdrawals.insertOne(withdrawDoc);
    } catch (e) {
        // The balance was already deducted by the gate above — put everything back
        // so the user is not charged for a request that was never saved.
        console.error('withdraw insert failed, rolling back:', e.message);
        await users.updateOne({ _id: id }, undoOps).catch(err => console.error('withdraw rollback failed:', err.message));
        return res.status(500).json({ ok: false, error: 'withdraw_save_failed', message: 'Could not save your withdrawal request. Your balance was not charged — please try again.' });
    }

    if (ADMIN_ID) {
        const adminText =
            `💸 <b>New Withdraw Request</b>\n\n` +
            `👤 User: <code>${id}</code>${verified.user.username ? ' (@' + escHtml(verified.user.username) + ')' : ''}\n` +
            `🪙 WTC: <b>${wtcAmount.toLocaleString()}</b>\n` +
            `💰 Amount: <b>$${netUsd.toFixed(4)} ${methodConfig.currency}</b>\n` +
            `📤 Method: <b>${methodConfig.label}</b>\n` +
            `📍 Address: <code>${escHtml(details)}</code>\n` +
            `📊 Total withdrawals so far: <b>${user.withdrawalCount || 0}</b>\n` +
            `🕒 Last withdraw: <b>${prevWithdraw ? `${fmtBDDateTime(prevWithdraw.createdAt)} — ${(prevWithdraw.wtcAmount || 0).toLocaleString()} WTC (${prevWithdraw.status})` : 'Never (first withdrawal)'}</b>\n` +
            `👥 Total referrals: <b>${user.referralCount || 0}</b>\n` +
            `📅 ${fmtBDDateTime(withdrawDoc.createdAt)}\n` +
            `🆔 Request: <code>${inserted.insertedId}</code>`;
        // The message_id is stored on the withdrawal so the wrong-address flow can edit
        // this admin message later, from the user's chat.
        try {
            const sent = await tgSend(ADMIN_ID, adminText, { reply_markup: { inline_keyboard: [
                [{ text: '✅ Approve', callback_data: `wd_approve_${inserted.insertedId}` },
                 { text: '❌ Reject', callback_data: `wd_reject_${inserted.insertedId}` }],
                [{ text: '⚠️ Wrong Address', callback_data: `wd_wrongaddr_${inserted.insertedId}` }],
                // For scripted withdraw spam: bans the user and wipes their whole
                // balance (wd_banscam_ handler in api/bot.js).
                [{ text: '🚫 Ban & Wipe (Scam)', callback_data: `wd_banscam_${inserted.insertedId}` }],
            ] } });
            if (sent?.ok && sent.result?.message_id) {
                await withdrawals.updateOne(
                    { _id: inserted.insertedId },
                    { $set: { adminMsgChatId: ADMIN_ID, adminMsgId: sent.result.message_id } }
                );
            }
        } catch { /* non-blocking — the request is still saved even if this notification fails */ }
    }

    return res.status(200).json({
        ok: true,
        withdrawId: inserted.insertedId,
        wtcAmount, netUsd,
        newWtcBalance: gate.wtcBalance,
        status: 'pending',
    });
}

export default async function handler(req, res) {
    const { db } = await connectToDatabase();

    if (req.method === 'GET') {
        const { action } = req.query;
        if (action === 'status') return handleStatus(req, res, db);
        if (action === 'history') return handleHistory(req, res, db);
        return res.status(400).json({ ok: false, error: 'unknown_action' });
    }

    if (req.method === 'POST') {
        return handleCreate(req, res, db);
    }

    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
        }
