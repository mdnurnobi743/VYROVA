// api/payments.js — ⚠️ MERGED (this update) — Vercel's Hobby/free plan caps
// a project at 12 serverless functions total, and this project was already
// at 11 before any of this TON-payment work. Rather than add 4 new files
// (api/taskcreate.js, api/cron/checkTaskCreateDeposits.js) and blow past
// the cap, they are combined into this ONE file.
// ⚠️ REMOVED (update) — the "Punch Key" (buy a valid referral with TON)
// system was removed completely. Only Create Task payments remain here.
//
// ── user-facing endpoints (called by the Mini App, index.html) ──
//   POST /api/payments   { resource:'taskcreate', action:'create'|'cancel', initData, ... }
//   GET  /api/payments?resource=taskcreate&action=status|myTasks&initData=...&orderId=...
//
// ── cron entry point (called by an EXTERNAL cron service, e.g. cron-job.org —
//    Vercel's own Cron Triggers only run once/day on the Hobby plan, far
//    too slow for a "credited within 1-5 minutes" promise) ──
//   POST /api/payments?cron=checkDeposits
//   Header: Authorization: Bearer <CRON_SECRET>
//   Runs the Create Task on-chain deposit check.

import { connectToDatabase } from '../lib/mongodb.js';
import { ObjectId } from 'mongodb';
import { tgSend } from '../lib/telegram.js';
import { verifyTelegramInitData } from '../lib/telegramAuth.js';
import {
    TASK_CREATE_PACKAGES, TASK_CREATE_ORDER_EXPIRY_MINUTES, TASK_CREATE_REWARD_PER_TASK_WTC,
} from '../lib/constants.js';
import { TON_RECEIVE_ADDRESS, randomTonMemo, buildTonDeepLink, fetchRecentTonTransactions } from '../lib/tonPay.js';

const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID;
const TASK_MODERATOR_ID = process.env.TASK_MODERATOR_ID;
// A payment is accepted if it's at least this fraction of the sticker
// price — a small tolerance for any wallet-side rounding of nanoTON.
// ASSUMED 97% (not specified) — tune freely. Shared by both cron checks below.
const MIN_ACCEPT_RATIO = 0.97;

// ════════════════════════════════════════════════════════════════════
// CREATE TASK — a user pays TON to get their OWN task queued for admin
// review, and once approved (api/bot.js "🕐 Pending Review"), it goes live
// in the Exclusive task section. This section NEVER inserts the real task
// itself — that only happens in the cron section further down, once
// payment is independently verified on-chain. Was api/taskcreate.js.
// ════════════════════════════════════════════════════════════════════

const TC_MAX_TITLE_LENGTH = 80;

const tcRandomMemo = () => randomTonMemo('TC');

function tcOrderResponse(order) {
    const deepLink = buildTonDeepLink(order.amountNanoTon, order.memo);
    return {
        ok: true,
        order: {
            id: String(order._id),
            memo: order.memo,
            amountNanoTon: order.amountNanoTon,
            taskCount: order.taskCount,
            address: TON_RECEIVE_ADDRESS,
            status: order.status,
            expiresAt: order.expiresAt,
            deepLink,
        },
    };
}

// Validates + normalizes the task draft the user is paying to publish.
// Mirrors api/bot.js's admin add-task flow's own channelId/url conventions
// exactly (e.g. auto-prefixing '@', deriving the t.me link) so a
// user-created task is indistinguishable in shape from an admin one.
function tcBuildDraft(body) {
    const title = String(body.title || '').trim();
    if (!title) return { error: 'missing_fields' };
    if (title.length > TC_MAX_TITLE_LENGTH) return { error: 'title_too_long' };

    const verifyType = body.verifyType === 'api' ? 'api' : (body.verifyType === 'link' ? 'link' : null);
    if (!verifyType) return { error: 'missing_fields' };

    if (verifyType === 'api') {
        let channelUsername = String(body.channelUsername || '').trim().replace(/^@/, '');
        // also accept a pasted https://t.me/<name> link
        const tMeMatch = channelUsername.match(/t\.me\/([a-zA-Z0-9_]+)/);
        if (tMeMatch) channelUsername = tMeMatch[1];
        if (!channelUsername) return { error: 'missing_fields' };
        const channelId = `@${channelUsername}`;
        return { draft: { title, verifyType, channelId, url: `https://t.me/${channelUsername}` } };
    }

    // verifyType === 'link'
    const url = String(body.url || '').trim();
    if (!url || !/^https?:\/\//i.test(url)) return { error: 'invalid_url' };
    return { draft: { title, verifyType, channelId: null, url } };
}

async function tcHandleCreate(req, res, db) {
    if (!TON_RECEIVE_ADDRESS) {
        console.error('payments/taskcreate create: TON_RECEIVE_ADDRESS env var not set');
        return res.status(500).json({ ok: false, error: 'server_misconfigured' });
    }
    const verified = verifyTelegramInitData(req.body?.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const userId = String(verified.user.id);

    const users = db.collection('users');
    const orders = db.collection('taskCreateOrders');

    const user = await users.findOne({ _id: userId }, { projection: { isBanned: 1 } });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
    if (user.isBanned) return res.status(403).json({ ok: false, error: 'banned' });

    const pkg = TASK_CREATE_PACKAGES[String(req.body?.package)];
    if (!pkg) return res.status(400).json({ ok: false, error: 'invalid_package' });

    const { draft, error } = tcBuildDraft(req.body || {});
    if (error) return res.status(400).json({ ok: false, error });

    // ── one pending order per user at a time  ──
    const now = new Date();
    const existing = await orders.findOne({ userId, status: 'pending', expiresAt: { $gt: now } });
    if (existing) return res.status(200).json(tcOrderResponse(existing));

    const expiresAt = new Date(now.getTime() + TASK_CREATE_ORDER_EXPIRY_MINUTES * 60 * 1000);

    let order = null;
    for (let attempt = 0; attempt < 3 && !order; attempt++) {
        try {
            const doc = {
                userId,
                memo: tcRandomMemo(),
                package: String(req.body.package),
                taskCount: pkg.taskCount,
                amountNanoTon: pkg.priceNanoTon,
                draft,
                status: 'pending',
                createdAt: now,
                expiresAt,
            };
            const result = await orders.insertOne(doc);
            order = { ...doc, _id: result.insertedId };
        } catch (e) {
            if (e?.code === 11000 && attempt < 2) continue; // duplicate memo — retry with a fresh one
            throw e;
        }
    }
    if (!order) return res.status(500).json({ ok: false, error: 'server_error' });

    return res.status(200).json(tcOrderResponse(order));
}

async function tcHandleStatus(req, res, db) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    const verified = verifyTelegramInitData(req.query.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const userId = String(verified.user.id);

    const { orderId } = req.query;
    if (!orderId) return res.status(400).json({ ok: false, error: 'missing_fields' });
    let objId;
    try { objId = new ObjectId(orderId); } catch { return res.status(400).json({ ok: false, error: 'invalid_order_id' }); }

    const order = await db.collection('taskCreateOrders').findOne({ _id: objId, userId });
    if (!order) return res.status(404).json({ ok: false, error: 'order_not_found' });

    return res.status(200).json({ ok: true, status: order.status, expiresAt: order.expiresAt });
}

async function tcHandleCancel(req, res, db) {
    const verified = verifyTelegramInitData(req.body?.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const userId = String(verified.user.id);

    const { orderId } = req.body || {};
    if (!orderId) return res.status(400).json({ ok: false, error: 'missing_fields' });
    let objId;
    try { objId = new ObjectId(orderId); } catch { return res.status(400).json({ ok: false, error: 'invalid_order_id' }); }

    // ⚠️ same caveat as any cancelled order — a late payment against a
    // cancelled order is NOT auto-credited, the frontend warns about this.
    await db.collection('taskCreateOrders').updateOne(
        { _id: objId, userId, status: 'pending' },
        { $set: { status: 'expired', expiredAt: new Date(), cancelledByUser: true } }
    );
    return res.status(200).json({ ok: true });
}

async function tcHandleMyTasks(req, res, db) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    const verified = verifyTelegramInitData(req.query.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const userId = String(verified.user.id);

    const taskDocs = await db.collection('tasks')
        .find({ createdBy: userId, isUserCreated: true })
        .project({ title: 1, limit: 1, completionCount: 1, createdAt: 1, completedAt: 1, category: 1, isApproved: 1, reviewStatus: 1 })
        .sort({ createdAt: -1 })
        .limit(50)
        .toArray();

    return res.status(200).json({ ok: true, tasks: taskDocs });
}

async function taskcreateRouter(req, res, db) {
    if (req.method === 'POST') {
        const { action } = req.body || {};
        if (action === 'create') return tcHandleCreate(req, res, db);
        if (action === 'cancel') return tcHandleCancel(req, res, db);
        return res.status(400).json({ ok: false, error: 'unknown_action' });
    }
    if (req.method === 'GET') {
        const { action } = req.query;
        if (action === 'status') return tcHandleStatus(req, res, db);
        if (action === 'myTasks') return tcHandleMyTasks(req, res, db);
        return res.status(400).json({ ok: false, error: 'unknown_action' });
    }
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
}

// ════════════════════════════════════════════════════════════════════
// CRON — verifies Create Task TON payments ON-CHAIN. Nothing about a payment is ever trusted from the client — this
// is the ONLY place a taskCreateOrders doc is ever allowed
// to flip 'pending' → 'paid'. Was api/cron/checkPunchKeyDeposits.js +
// api/cron/checkTaskCreateDeposits.js.
//
// No separate "already-processed transaction" table is needed for either
// half — the atomic status:'pending'→'paid' gate on each ORDER itself is
// what prevents double-crediting (same pattern as the atomic gates in
// lib/referral.js).
// ════════════════════════════════════════════════════════════════════

async function cronCheckTaskCreate(db, txs, now) {
    const orders = db.collection('taskCreateOrders');
    const tasks = db.collection('tasks');

    const expireResult = await orders.updateMany(
        { status: 'pending', expiresAt: { $lte: now } },
        { $set: { status: 'expired', expiredAt: now } }
    );

    const pendingCount = await orders.countDocuments({ status: 'pending' });
    if (pendingCount === 0) return { expired: expireResult.modifiedCount, matched: 0 };

    let matched = 0;
    for (const tx of txs) {
        const inMsg = tx.in_msg;
        if (!inMsg || !inMsg.message) continue; // no comment → can't belong to any order
        const memo = String(inMsg.message).trim();
        if (!memo.startsWith('TC')) continue; // not one of ours — skip fast without a DB round-trip
        const receivedNanoTon = Number(inMsg.value || 0);
        if (!receivedNanoTon) continue;

        const order = await orders.findOne({ memo, status: 'pending' });
        if (!order) continue; // no matching pending order (already paid/expired/never existed)
        if (receivedNanoTon < order.amountNanoTon * MIN_ACCEPT_RATIO) continue; // underpaid — leave pending until it expires

        const txHash = tx.transaction_id?.hash || null;

        // ⚠️ ATOMIC — gated on status:'pending' so this exact order (and
        // therefore the task insert below) can never fire twice, no matter
        // how many times this loop or a later run sees the tx again.
        const claimed = await orders.findOneAndUpdate(
            { _id: order._id, status: 'pending' },
            { $set: { status: 'paid', paidAt: now, txHash, receivedNanoTon } },
            { returnDocument: 'after' }
        );
        if (!claimed) continue; // lost the race to another concurrent run — already handled

        // ── publish the task doc as pending-review, exactly once, gated
        // behind the atomic flip above — see api/bot.js "🕐 Pending Review" ──
        const taskDoc = {
            title: claimed.draft.title,
            url: claimed.draft.url,
            channelId: claimed.draft.channelId,
            category: 'exclusive',
            verifyType: claimed.draft.verifyType,
            rewardWtc: TASK_CREATE_REWARD_PER_TASK_WTC,
            rewardCurrency: 'wtc',
            rewardUsdt: null,
            limit: claimed.taskCount,
            completionCount: 0,
            isApproved: false, // ⚠️ NOT live yet — see reviewStatus below
            reviewStatus: 'pending_review',
            createdAt: now,
            createdBy: claimed.userId,
            isUserCreated: true, // gates the 5-day post-completion TTL (models/schema.js), distinguishes from admin-created tasks with the same shape
        };
        const insertResult = await tasks.insertOne(taskDoc);
        await orders.updateOne({ _id: claimed._id }, { $set: { createdTaskId: insertResult.insertedId } });

        matched++;
        // task-marketplace notifications
        // switched from Bangla to English.
        tgSend(claimed.userId,
            `✅ <b>Payment Confirmed!</b>\n\n` +
            `📋 ${taskDoc.title}\n` +
            `👥 ${taskDoc.limit} people will be able to complete it (+${TASK_CREATE_REWARD_PER_TASK_WTC} WTC each)\n\n` +
            `⏳ It's now waiting for admin review — once approved, it'll go live for everyone in the "⭐ Exclusive" tab. 🎉`
        ).catch(() => {});

        // ⚠️ ping admin + task moderator so a paid task doesn't sit
        // unnoticed in the queue. Best-effort, doesn't block the loop.
        const reviewMsg =
            `🆕 <b>New Task Waiting for Review</b>\n\n` +
            `📋 ${taskDoc.title}\n` +
            `🔗 ${taskDoc.url}\n` +
            `👤 Type: ${taskDoc.verifyType === 'api' ? 'Channel/Group Join (API)' : 'Link'}\n` +
            `👥 ${taskDoc.limit} slots · 💰 ${taskDoc.rewardWtc} WTC/person\n\n` +
            `Go to "🕐 Pending Review" in the admin panel to approve/reject.`;
        if (ADMIN_ID) tgSend(ADMIN_ID, reviewMsg).catch(() => {});
        if (TASK_MODERATOR_ID) tgSend(TASK_MODERATOR_ID, reviewMsg).catch(() => {});
    }
    return { expired: expireResult.modifiedCount, matched };
}

async function handleCronCheckDeposits(req, res, db) {
    const authHeader = req.headers['authorization'];
    if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    if (!TON_RECEIVE_ADDRESS) {
        console.error('payments cron checkDeposits: TON_RECEIVE_ADDRESS env var not set');
        return res.status(500).json({ ok: false, error: 'server_misconfigured' });
    }

    try {
        const now = new Date();

        // Both order types share the SAME receiving wallet, so one
        // TonCenter fetch covers both checks below — no reason to hit the
        // API twice per cron run.
        const txs = await fetchRecentTonTransactions();

        const taskCreateResult = await cronCheckTaskCreate(db, txs, now);

        return res.status(200).json({
            ok: true,
            checked: txs.length,
            taskCreate: taskCreateResult,
        });
    } catch (err) {
        console.error('payments cron checkDeposits error:', err);
        if (ADMIN_ID) {
            await tgSend(ADMIN_ID, `🚨 <b>TON Deposit Check FAILED</b>\n\n<code>${String(err?.message || err).slice(0, 500)}</code>`).catch(() => {});
        }
        return res.status(500).json({ ok: false, error: 'server_error' });
    }
}

// ════════════════════════════════════════════════════════════════════
// TOP-LEVEL DISPATCH
// ════════════════════════════════════════════════════════════════════

export default async function handler(req, res) {
    const { db } = await connectToDatabase();

    // ── cron: POST /api/payments?cron=checkDeposits ──
    if (req.method === 'POST' && req.query.cron === 'checkDeposits') {
        return handleCronCheckDeposits(req, res, db);
    }

    // ── user-facing: dispatched by `resource` (body for POST, query for GET) ──
    const resource = req.method === 'GET' ? req.query.resource : req.body?.resource;
    if (resource === 'taskcreate') return taskcreateRouter(req, res, db);
    return res.status(400).json({ ok: false, error: 'unknown_resource' });
}
