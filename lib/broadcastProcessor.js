// lib/broadcastProcessor.js — NEW (this update)
//
// ⚠️ ARCHITECTURE CHANGE: after FOUR attempts to make Vercel serverless
// functions reliably trigger THEMSELVES to continue a broadcast (bare
// fetch → waitUntil(fetch) → waitUntil with abort → whole-invocation time
// budget), the self-chaining pattern kept dying after exactly one chunk,
// consistently, every single time — never randomly. The first hop
// (triggered by api/bot.js, a fresh invocation with its own full time
// budget) always worked; a function trying to re-trigger ITSELF near the
// end of its own already-mostly-spent budget never reliably did, no
// matter how the timing was tuned. This points to a structural limitation
// of self-triggering on Vercel Hobby, not a tunable timing bug.
//
// New approach: an external free cron pinger (cron-job.org, 1-minute
// granularity, no cost) hits api/broadcastTick.js once a minute. That
// endpoint has no self-triggering logic at all — it just processes
// whatever the current broadcast job's next chunk is and returns. The
// external service is what "continues" the broadcast, not the function
// triggering itself. This is a completely different, load-bearing
// mechanism from anything tried before — not another timing tweak.
//
// This file holds the actual per-chunk processing logic, shared by:
//   - api/broadcastWorker.js — manual, admin-triggered, requires a specific jobId
//   - api/broadcastTick.js   — cron-triggered, auto-picks whatever job is running
// so the two entry points can't drift out of sync with each other.

import { connectToDatabase } from './mongodb.js';
import { tgSend, tgSendPhoto } from './telegram.js';
import { tryLockJob, updateJobProgress, markJobDone, BROADCAST_MSG_DELAY_MS } from './broadcastJob.js';

const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID;

const CANDIDATE_BATCH_SIZE = 500;
// Deliberately conservative — Vercel Hobby's real cutoff is ~10s; this
// stays comfortably under it, measured from the true top of the call
// (before any DB work), not just the send loop.
const TOTAL_BUDGET_MS = 8000;
// Reserved for updateJobProgress's DB write, guaranteed available no
// matter how long the DB overhead up front ends up taking.
const WRAPUP_RESERVE_MS = 1500;

// Processes one chunk of `jobId`. Returns a plain result object — callers
// decide how to respond to their own request.
export async function processBroadcastChunk(jobId) {
    const FUNCTION_START = Date.now();

    const job = await tryLockJob(jobId);
    if (!job) {
        // Either the job doesn't exist, already finished, or another
        // invocation currently holds the lock — nothing to do here.
        return { ok: true, skipped: true };
    }

    const { db } = await connectToDatabase();
    const users = db.collection('users');

    // merges the job's optional audienceFilter (see createBroadcastJob
    // in lib/broadcastJob.js) with the pagination cursor. A normal admin
    // broadcast has no audienceFilter, so this is exactly the old `{}`/`{_id:{$gt:...}}`
    // behavior unchanged; a targeted job (e.g. the inactivity reminder) narrows it.
    const query = { ...(job.audienceFilter || {}), ...(job.lastUserId ? { _id: { $gt: job.lastUserId } } : {}) };
    const candidates = await users.find(query, { projection: { _id: 1 } })
        .sort({ _id: 1 })
        .limit(CANDIDATE_BATCH_SIZE)
        .toArray();

    if (candidates.length === 0) {
        await markJobDone(jobId);
        await tgSend(ADMIN_ID, `✅ <b>Broadcast Done!</b>\n\nSent: <b>${job.sentCount}</b> | Failed: <b>${job.failedCount}</b>`, {
            reply_markup: { inline_keyboard: [[{ text: '◀️ Back to Menu', callback_data: 'a_menu' }]] },
        });
        return { ok: true, done: true, sentCount: job.sentCount, failedCount: job.failedCount };
    }

    const extra = {};
    if (job.buttonText && job.buttonUrl) {
        extra.reply_markup = { inline_keyboard: [[{ text: job.buttonText, url: job.buttonUrl }]] };
    }

    let sentDelta = 0, failedDelta = 0;
    let lastUserId = job.lastUserId;
    const sendDeadline = FUNCTION_START + TOTAL_BUDGET_MS - WRAPUP_RESERVE_MS;

    for (let i = 0; i < candidates.length; i++) {
        const u = candidates[i];
        try {
            if (job.photoFileId) {
                await tgSendPhoto(u._id, job.photoFileId, job.text, extra);
            } else {
                await tgSend(u._id, job.text, extra);
            }
            sentDelta++;
        } catch {
            failedDelta++;
        }
        lastUserId = u._id;
        // Checked AFTER processing the current user — guarantees at least
        // one user gets sent per invocation even on a slow-DB day.
        if (Date.now() >= sendDeadline) break;
        if (i < candidates.length - 1) await new Promise((r) => setTimeout(r, BROADCAST_MSG_DELAY_MS));
    }

    await updateJobProgress(jobId, { lastUserId, sentDelta, failedDelta });

    return { ok: true, sentThisChunk: sentDelta, failedThisChunk: failedDelta };
}
