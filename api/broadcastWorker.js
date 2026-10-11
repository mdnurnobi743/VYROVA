// api/broadcastWorker.js — ⚠️ SIMPLIFIED (this update)
//
// Manually processes ONE chunk of a SPECIFIC broadcast job. No longer
// self-triggers the next chunk (that pattern was tried four different ways
// and never reliably worked on Vercel Hobby — see lib/broadcastProcessor.js
// for the full story). Continuing a broadcast automatically is now the
// job of api/broadcastTick.js, called every minute by an external free
// cron service (cron-job.org). This endpoint remains for:
//   - api/bot.js's one-time kick right after a broadcast is queued (gets
//     the first chunk out immediately instead of waiting up to a minute
//     for the next cron tick)
//   - manually nudging a specific job forward from a browser if needed
//
// GET/POST /api/broadcastWorker?jobId=...&secret=<BOT_TOKEN>

import { processBroadcastChunk } from '../lib/broadcastProcessor.js';

const BOT_TOKEN = process.env.BOT_TOKEN;

export default async function handler(req, res) {
    if (!BOT_TOKEN || req.query.secret !== BOT_TOKEN) {
        return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const jobId = req.query.jobId;
    if (!jobId) return res.status(400).json({ ok: false, error: 'missing_job_id' });

    const result = await processBroadcastChunk(jobId);
    return res.status(200).json(result);
}
