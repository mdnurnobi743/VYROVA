// api/broadcastStatus.js — NEW
//
// Lets the admin check a broadcast's real progress (sentCount / totalUsers,
// status, how far the cursor has gotten) instead of guessing from whether a
// specific test account has received it yet — a large broadcast can take
// several minutes to reach every user, and any single account (especially a
// recently-created admin test account near the end of the sorted list) may
// simply not have been reached yet even while the job is progressing fine.
//
// GET /api/broadcastStatus?secret=<BOT_TOKEN>
// Visit from a browser exactly like /api/admin/setup-indexes.

import { getLatestBroadcastJob } from '../lib/broadcastJob.js';

const BOT_TOKEN = process.env.BOT_TOKEN;

export default async function handler(req, res) {
    if (!BOT_TOKEN || req.query.secret !== BOT_TOKEN) {
        return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const job = await getLatestBroadcastJob();
    if (!job) return res.status(200).json({ ok: true, message: 'No broadcast jobs found yet.' });

    const percent = job.totalUsers ? Math.round((job.sentCount + job.failedCount) / job.totalUsers * 100) : 0;

    return res.status(200).json({
        ok: true,
        status: job.status,
        progress: `${job.sentCount + job.failedCount} / ${job.totalUsers} (${percent}%)`,
        sentCount: job.sentCount,
        failedCount: job.failedCount,
        totalUsers: job.totalUsers,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        finishedAt: job.finishedAt,
        // If status is 'running'/'pending' and updatedAt is more than ~30s
        // old, the self-trigger chain has likely stalled (e.g. a network
        // hiccup between hops) — re-visiting the worker URL below with this
        // jobId manually resumes it from exactly where it left off.
        resumeUrl: job.status !== 'done' ? `/api/broadcastWorker?jobId=${job._id}&secret=<BOT_TOKEN>` : null,
    });
}
