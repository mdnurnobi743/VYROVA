// api/data.js — public read-only data for the mini app.
//   GET /api/data?type=videos
//   GET /api/data?type=games
//   GET /api/data?type=tasks
//   GET /api/data?type=leaderboard        (top 20 by referralCount)
//   GET /api/data?type=weeklyContest      (top 10 by weeklyReferralCount)

import { connectToDatabase } from '../lib/mongodb.js';

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    }

    try {
        const { type } = req.query;
        const { db } = await connectToDatabase();

        if (type === 'videos') {
            const videos = await db.collection('videos')
                .find({ isActive: true })
                .sort({ createdAt: -1 })
                .limit(50)
                .toArray();
            return res.status(200).json({ ok: true, videos });
        }

        // 🎮 NEW — Games section (admin adds games from the bot, stored in `games`)
        if (type === 'games') {
            const games = await db.collection('games')
                .find({ isActive: true })
                .project({ title: 1, gameUrl: 1, thumbnail: 1 })
                .sort({ createdAt: -1 })
                .limit(300)
                .toArray();
            return res.status(200).json({ ok: true, games });
        }

        if (type === 'tasks') {
            const tasks = await db.collection('tasks')
                .find({ isApproved: true })
                .sort({ createdAt: -1 })
                .limit(50)
                .toArray();
            return res.status(200).json({ ok: true, tasks });
        }

        if (type === 'leaderboard') {
            // ফিক্স: আগে ভুলে lifetimeWtcEarned দিয়ে সর্ট হতো, কিন্তু লেবেল ছিল "Top Referrer" —
            // এখন আসল referralCount দিয়েই সর্ট ও দেখানো হচ্ছে
            const top = await db.collection('users')
                .find({ isBanned: { $ne: true } })
                .project({ telegramUsername: 1, firstName: 1, referralCount: 1 })
                .sort({ referralCount: -1 })
                .limit(20)
                .toArray();
            return res.status(200).json({ ok: true, leaderboard: top });
        }

        // Weekly Referral Contest (mini app "Milestones" button). Reads
        // the SAME live `weeklyReferralCount` field the admin panel's a_weekly
        // screen uses, so it automatically reflects the admin's manual
        // "🔄 Reset week now" (bot.js a_weekly_reset_confirm) — no separate
        // reset needed here, it's the same field/collection.
        if (type === 'weeklyContest') {
            const top = await db.collection('users')
                .find({ isBanned: { $ne: true }, weeklyReferralCount: { $gt: 0 } })
                .project({ telegramUsername: 1, firstName: 1, weeklyReferralCount: 1 })
                .sort({ weeklyReferralCount: -1 })
                .limit(10)
                .toArray();
            return res.status(200).json({ ok: true, top });
        }

        return res.status(400).json({ ok: false, error: 'unknown_type' });
    } catch (err) {
        console.error('data error:', err);
        return res.status(500).json({ ok: false, error: 'server_error' });
    }
}
