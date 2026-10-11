// api/cron/weeklyReferral.js — WEEKLY REFERRAL COMPETITION (OPTIONAL cron)
//
// ⚠️ NOT currently wired into vercel.json — the admin is running this
// manually via bot.js's a_weekly → "🔄 Reset week now" button instead (same
// underlying rule, same weeklyReferralReports collection). This file is kept
// as an optional automatic alternative if the admin later decides they'd
// rather it run itself every Friday instead of tapping a button. To enable:
// add `{ "path": "/api/cron/weeklyReferral", "schedule": "..." }` to
// vercel.json's `crons` array.
//
// Mirrors bot.js's manual flow exactly: only users with AT LEAST
// WEEKLY_REFERRAL_MIN_COUNT referrals this week qualify, top
// WEEKLY_REFERRAL_MAX_WINNERS of those get saved as winners — could be
// fewer than that (even 0) if not enough people crossed the threshold. NO
// automatic WTC payout — winners are saved to `weeklyReferralReports` for
// the admin to review and pay manually (via 📜 Weekly Report in bot.js).
//
// Vercel signs cron invocations with `Authorization: Bearer ${CRON_SECRET}`
// (auto-provisioned by Vercel) — verified below so nobody else can trigger this.

import { connectToDatabase } from '../../lib/mongodb.js';
import { tgSend } from '../../lib/telegram.js';
import { WEEKLY_REFERRAL_MIN_COUNT, WEEKLY_REFERRAL_MAX_WINNERS } from '../../lib/constants.js';

const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID;

export default async function handler(req, res) {
    const authHeader = req.headers['authorization'];
    if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    try {
        const { db } = await connectToDatabase();
        const users = db.collection('users');

        const weekly = await users.find({ weeklyReferralCount: { $gt: 0 }, isBanned: { $ne: true } })
            .sort({ weeklyReferralCount: -1 })
            .limit(20)
            .project({ firstName: 1, telegramUsername: 1, weeklyReferralCount: 1 })
            .toArray();

        const winners = weekly
            .filter(u => u.weeklyReferralCount >= WEEKLY_REFERRAL_MIN_COUNT)
            .slice(0, WEEKLY_REFERRAL_MAX_WINNERS)
            .map(u => ({ userId: u._id, firstName: u.firstName || null, telegramUsername: u.telegramUsername || null, weeklyReferralCount: u.weeklyReferralCount }));

        await db.collection('weeklyReferralReports').insertOne({
            weekEndedAt: new Date(),
            winners,
            totalParticipants: weekly.length,
        });

        await users.updateMany({ weeklyReferralCount: { $ne: 0 } }, { $set: { weeklyReferralCount: 0 } });

        if (ADMIN_ID) {
            const summary = winners.length
                ? winners.map((w, i) => `${i + 1}. @${w.telegramUsername || w.firstName || w.userId} — ${w.weeklyReferralCount} refs`).join('\n')
                : `No winners this week — nobody reached ${WEEKLY_REFERRAL_MIN_COUNT}+ referrals.`;
            await tgSend(ADMIN_ID,
                `📊 <b>Weekly Referral — Auto Report Saved</b>\n\n🏆 ${winners.length} winner(s):\n${summary}\n\n` +
                `Send rewards manually, then check 📜 Weekly Report in the admin panel anytime.\n` +
                `🔄 Everyone's weekly counter has been reset for the new week.`
            ).catch(() => {});
        }

        return res.status(200).json({ ok: true, winners: winners.length });
    } catch (err) {
        console.error('weeklyReferral cron error:', err);
        if (ADMIN_ID) {
            await tgSend(ADMIN_ID, `🚨 <b>Weekly Referral Cron FAILED</b>\n\n<code>${String(err?.message || err)}</code>\n\nWeekly counters were NOT reset — safe to retry.`).catch(() => {});
        }
        return res.status(500).json({ ok: false, error: 'server_error' });
    }
}
