// api/admin/setup-indexes.js — NEW
//
// আপনার mobile-only setup এ `node models/schema.js` চালানোর কোনো উপায় নেই
// (terminal/Node.js নেই)। তাই এই endpoint টা ঠিক একই index-creation কোড
// চালায়, কিন্তু শুধু একটা browser এ URL খুলে GET request পাঠিয়েই ট্রিগার
// করা যায়।
//
// ব্যবহার (deploy হওয়ার পর, মোবাইল Chrome এ):
//   https://<your-vercel-domain>/api/admin/setup-indexes?secret=<your BOT_TOKEN>
//
// ⚠️ SECURITY: BOT_TOKEN ইতিমধ্যে আপনার Vercel env এ secret হিসেবে সেভ করা
// আছে এবং কখনো ইউজারের কাছে পাঠানো হয় না — তাই এটাকেই এখানে shared-secret
// হিসেবে reuse করা হচ্ছে, আলাদা কোনো নতুন env variable যোগ করার দরকার নেই।
// ভুল/অনুপস্থিত secret দিলে 401 ফেরত আসবে, কিছু চলবে না।
//
// createIndex সবসময় idempotent — একই index বারবার বানাতে চাইলেও দ্বিতীয়
// বার থেকে MongoDB চুপচাপ কিছু করে না (already exists), তাই এই endpoint
// বারবার visit করলেও কোনো ক্ষতি নেই — safe to re-run anytime after future
// schema changes too.

import { connectToDatabase } from '../../lib/mongodb.js';

const BOT_TOKEN = process.env.BOT_TOKEN;

export default async function handler(req, res) {
    if (!BOT_TOKEN || req.query.secret !== BOT_TOKEN) {
        return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const results = [];
    try {
        const { db } = await connectToDatabase();

        const steps = [
            ['users.referredBy', () => db.collection('users').createIndex({ referredBy: 1 })],
            ['users.isBanned', () => db.collection('users').createIndex({ isBanned: 1 })],
            ['users.weeklyReferralCount', () => db.collection('users').createIndex({ weeklyReferralCount: -1 })],
            ['users.bannedAt (partial TTL 60d, isBanned:true only)', () => db.collection('users').createIndex(
                { bannedAt: 1 },
                { expireAfterSeconds: 5184000, partialFilterExpression: { isBanned: true } }
            )],
            ['videos.isActive+createdAt', () => db.collection('videos').createIndex({ isActive: 1, createdAt: -1 })],
            // 🎮 NEW — Games section (permanent collection, so no TTL — just lookup indexes)
            ['games.isActive+createdAt', () => db.collection('games').createIndex({ isActive: 1, createdAt: -1 })],
            ['games.gameUrl', () => db.collection('games').createIndex({ gameUrl: 1 })],
            ['tasks.isApproved+category+createdAt', () => db.collection('tasks').createIndex({ isApproved: 1, category: 1, createdAt: -1 })],
            ['withdrawals.userId+createdAt', () => db.collection('withdrawals').createIndex({ userId: 1, createdAt: -1 })],
            ['withdrawals.details', () => db.collection('withdrawals').createIndex({ details: 1 })],
            ['promos.code (unique)', () => db.collection('promos').createIndex({ code: 1 }, { unique: true })],
            ['promos.expiresAt (TTL)', () => db.collection('promos').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })],
            // the two cleanup indexes for this update
            ['fingerprints.lastSeenAt (TTL 180d)', () => db.collection('fingerprints').createIndex({ lastSeenAt: 1 }, { expireAfterSeconds: 15552000 })],
            ['gifts.claimedAt (partial TTL 30d, status:claimed only)', () => db.collection('gifts').createIndex(
                { claimedAt: 1 },
                { expireAfterSeconds: 2592000, partialFilterExpression: { status: 'claimed' } }
            )],
            // spin history: TTL 30 days (2592000s) + lookup index for the admin user panel
            ['spinLogs.createdAt (TTL 30d)', () => db.collection('spinLogs').createIndex({ createdAt: 1 }, { expireAfterSeconds: 2592000 })],
            ['spinLogs.userId+createdAt', () => db.collection('spinLogs').createIndex({ userId: 1, createdAt: -1 })],
            ['weeklyReferralReports.weekEndedAt', () => db.collection('weeklyReferralReports').createIndex({ weekEndedAt: -1 })],
            ['adminState.updatedAt (TTL 1h)', () => db.collection('adminState').createIndex({ updatedAt: 1 }, { expireAfterSeconds: 3600 })],
            // resumable broadcast jobs (lib/broadcastJob.js). One doc
            // per broadcast campaign, auto-cleaned 30 days after it finishes.
            ['broadcastJobs.finishedAt (partial TTL 30d, status:done only)', () => db.collection('broadcastJobs').createIndex(
                { finishedAt: 1 },
                { expireAfterSeconds: 2592000, partialFilterExpression: { status: 'done' } }
            )],
            // Create Task (api/payments.js). See
            // models/schema.js's taskCreateOrders collection
            // docs for the full field shapes these indexes support.
            ['taskCreateOrders.memo (unique)', () => db.collection('taskCreateOrders').createIndex({ memo: 1 }, { unique: true })],
            ['taskCreateOrders.userId+status', () => db.collection('taskCreateOrders').createIndex({ userId: 1, status: 1 })],
            ['taskCreateOrders.expiresAt (partial TTL 1h, status:pending only)', () => db.collection('taskCreateOrders').createIndex(
                { expiresAt: 1 },
                { expireAfterSeconds: 3600, partialFilterExpression: { status: 'pending' } }
            )],
            ['taskCreateOrders.expiredAt (partial TTL 30d, status:expired only)', () => db.collection('taskCreateOrders').createIndex(
                { expiredAt: 1 },
                { expireAfterSeconds: 2592000, partialFilterExpression: { status: 'expired' } }
            )],
            ['tasks.completedAt (partial TTL 5d, isUserCreated:true only)', () => db.collection('tasks').createIndex(
                { completedAt: 1 },
                { expireAfterSeconds: 432000, partialFilterExpression: { isUserCreated: true } }
            )],
            ['tasks.createdBy+isUserCreated+createdAt ("My Created Tasks")', () => db.collection('tasks').createIndex({ createdBy: 1, isUserCreated: 1, createdAt: -1 })],
            ['tasks.isUserCreated+reviewStatus+createdAt ("🕐 Pending Review")', () => db.collection('tasks').createIndex({ isUserCreated: 1, reviewStatus: 1, createdAt: 1 })],
        ];

        for (const [name, fn] of steps) {
            try {
                await fn();
                results.push({ index: name, ok: true });
            } catch (err) {
                // একটা index fail করলেও বাকিগুলো চালিয়ে যাও — partial success useful
                results.push({ index: name, ok: false, error: err.message });
            }
        }

        const failed = results.filter(r => !r.ok);
        return res.status(200).json({ ok: failed.length === 0, results });
    } catch (err) {
        return res.status(500).json({ ok: false, error: 'server_error', message: err.message, results });
    }
                    }
