// lib/ipRegistry.js — SEASON 4: device-fingerprint-based one-account gate
// (raw IP retired as the primary key, kept only as a last-resort fallback)
//
// Season 3 keyed this purely by IP address. Bangladeshi mobile
// carriers (GP/Robi/Banglalink) run CGNAT: thousands of completely
// unrelated phones share the same public IP at the same time. That made
// this block trigger false positives for genuinely different people on
// genuinely different phones — exactly the "this isn't even my account"
// report that prompted this fix. The client already generates a device
// fingerprint (canvas+screen+timezone+locale hash, see
// generateDeviceFingerprint() in index.html) and sends it on every init —
// it just wasn't being used for this gate. Keying by fingerprint instead
// actually identifies the physical device, doesn't have the shared-IP
// false-positive problem, and matches the real rule being enforced here:
// "one account per phone", not "one account per IP".
//
// IP is kept ONLY as a fallback key for the rare case a fingerprint truly
// couldn't be generated client-side (crypto.subtle missing / ancient
// WebView) — better a rare IP-based false positive than letting the whole
// gate be skipped by anyone whose client happens to not support it.
//
// COLLECTION: ipRegistry  (name kept as-is — just a "one identity per
// device-or-IP key" registry now, renaming the collection isn't worth a
// migration)
//   { _id: "<fingerprint hash, or 'ip:<address>' as fallback>",
//     userId: "<current owner telegram id>", claimedAt: Date, lastSeenAt: Date }

// Vercel/most proxies put the real client IP first in x-forwarded-for.
// Fall back through the other common headers, then the raw socket as a last resort.
import { tgSend } from './telegram.js';
import { IP_SIGNUP_VELOCITY_WINDOW_MS } from './constants.js';

export function getClientIp(req) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
    if (req.headers['x-real-ip']) return String(req.headers['x-real-ip']).trim();
    return req.socket?.remoteAddress || 'unknown';
}

// records this signup against its raw client IP and returns how
// many NEW-ACCOUNT signups that same IP has produced inside
// IP_SIGNUP_VELOCITY_WINDOW_MS. Separate collection/key from the device
// registry above on purpose — see the constant's own comment in
// lib/constants.js for why this needs to be raw-IP-keyed, not
// fingerprint-or-IP-keyed, to actually catch a scripted farm.
// COLLECTION: ipSignupVelocity  { _id: "<ip>", recentSignups: [Date, ...] }
export async function recordSignupAndCheckVelocity(db, ip) {
    if (!ip || ip === 'unknown') return { count: 0 }; // never gate on a detection failure
    const now = new Date();
    const result = await db.collection('ipSignupVelocity').findOneAndUpdate(
        { _id: ip },
        { $push: { recentSignups: { $each: [now], $slice: -50 } } }, // capped rolling list — plenty for a few-minute window
        { upsert: true, returnDocument: 'after' }
    );
    const entry = result?.value !== undefined ? result.value : result;
    const windowStart = Date.now() - IP_SIGNUP_VELOCITY_WINDOW_MS;
    const count = (entry?.recentSignups || []).filter((t) => new Date(t).getTime() >= windowStart).length;
    return { count };
}

// Picks the registry key: the device fingerprint when it looks valid,
// otherwise an 'ip:'-prefixed fallback key (prefixed so it can never
// collide with a real fingerprint hash).
function registryKey(fingerprint, ip) {
    if (fingerprint && typeof fingerprint === 'string' && fingerprint.length >= 16) return fingerprint;
    if (ip && ip !== 'unknown') return `ip:${ip}`;
    return null;
}

// Returns { blocked: false } if this device/IP is free or already owned by userId.
// Returns { blocked: true, ownerId } if a DIFFERENT userId currently owns it.
// `key` is always returned too so callers can claim() without recomputing it.
//
// a collision on an `ip:`-fallback key (fingerprint generation
// failed client-side) used to hard-block exactly like a real fingerprint
// collision. Under Bangladeshi mobile carrier CGNAT, many unrelated phones
// share one public IP at the same time — this is the SAME false-positive
// class the fingerprint migration was originally meant to fix, just
// re-entering through the fallback path whenever a client can't produce a
// fingerprint. A real fingerprint match is a high-confidence "same physical
// device" signal and still hard-blocks. An IP-only match is now soft: entry
// is allowed through, but flagged (isFallbackCollision) so the caller can
// record it for admin review instead of locking out someone who may be a
// completely different person on a completely different phone.
export async function checkDevice(db, fingerprint, ip, userId) {
    const key = registryKey(fingerprint, ip);
    if (!key) return { blocked: false, key: null }; // never lock users out over a detection failure
    const isFallbackKey = key.startsWith('ip:');
    const entry = await db.collection('ipRegistry').findOne({ _id: key });
    if (!entry) return { blocked: false, unclaimed: true, key };
    if (entry.userId === userId) {
        // ⚠️ keep this device's TTL clock fresh while its real owner is
        // still actively using it. Fire-and-forget: never block the request
        // on this, and never let it affect the block/allow decision itself.
        db.collection('ipRegistry').updateOne({ _id: key }, { $set: { lastSeenAt: new Date() } }).catch(() => {});
        return { blocked: false, key };
    }
    if (isFallbackKey) {
        // Soft path — do not block, do not reassign the key, just surface
        // enough for the caller to log a review flag.
        return { blocked: false, fallbackCollision: true, ownerId: entry.userId, key };
    }
    return { blocked: true, ownerId: entry.userId, key };
}

// First-time claim of a free device/IP key — does not touch balances.
export async function claimDevice(db, key, userId) {
    if (!key) return;
    await db.collection('ipRegistry').updateOne(
        { _id: key },
        { $set: { userId, claimedAt: new Date(), lastSeenAt: new Date() } },
        { upsert: true }
    );
}

// "Switch account" — force-claim a device/IP key already owned by someone
// else, at the cost of wiping the switching user's own balance. Reassigns
// the ipRegistry mapping to this user; the PREVIOUS owner's account is
// untouched (they just no longer own this particular key — if they show up
// on it again later they'll hit the same block from the other side).
//
// this used to allow an unlimited number of switches with
// zero cooldown. The "wipe the switching user's balance" cost is real for an
// established account, but ZERO for a brand-new account (balance already
// 0) — meaning someone could spin up a fresh Telegram account, switch onto
// this device, farm that account's daily ad/video/task caps, take a free
// zero-referral first withdrawal (see FREE_WITHDRAW_MAX_WTC in
// constants.js), then repeat immediately with another fresh account. Now
// gated by SWITCH_COOLDOWN_HOURS — the same device key can only be
// force-switched once per cooldown window, closing the rapid-loop version
// of that exploit while still letting someone switch once a day for a
// genuine reason (new phone, a family member's turn, etc). Returns
// { ok:false, retryAfterMs } if still on cooldown — caller must check this
// before treating the switch as done.
const SWITCH_COOLDOWN_HOURS = 24;
export async function claimDeviceForUser(db, key, userId) {
    if (!key) return { ok: true }; // no key to gate on — nothing to switch, nothing to block either

    const registry = db.collection('ipRegistry');
    const entry = await registry.findOne({ _id: key });
    if (entry?.lastSwitchAt) {
        const cooldownMs = SWITCH_COOLDOWN_HOURS * 60 * 60 * 1000;
        const elapsedMs = Date.now() - new Date(entry.lastSwitchAt).getTime();
        if (elapsedMs < cooldownMs) {
            return { ok: false, retryAfterMs: cooldownMs - elapsedMs };
        }
    }

    const updated = await registry.findOneAndUpdate(
        { _id: key },
        {
            $set: { userId, claimedAt: new Date(), lastSeenAt: new Date(), lastSwitchAt: new Date() },
            $inc: { switchCount: 1 },
        },
        { upsert: true, returnDocument: 'after' }
    );
    await db.collection('users').updateOne(
        { _id: userId },
        {
            $set: {
                wtcBalance: 0,
                usdtBalance: 0,
                lifetimeWtcEarned: 0,
                pendingVideoWTC: 0,
                dailyVideoWtcMined: 0,
                lastAccountSwitchAt: new Date(),
            },
            $inc: { accountSwitchCount: 1 },
        }
    );

    // soft admin alert once a single device has been switched an
    // unusual number of TOTAL times (not just rapid-fire — this catches a
    // slower version of the same farming pattern, e.g. one switch a day for
    // weeks). Purely informational, same non-blocking pattern as the
    // referral-velocity alert in api/user.js — nothing here auto-bans.
    const switchCount = updated?.switchCount ?? updated?.value?.switchCount;
    if (switchCount === 5 || switchCount === 15 || switchCount === 50) {
        const { ADMIN_TELEGRAM_ID } = process.env;
        if (ADMIN_TELEGRAM_ID) {
            tgSend(
                ADMIN_TELEGRAM_ID,
                `🚩 <b>Device switched ${switchCount}× (no action taken)</b>\n\n` +
                `One device/IP key has now been force-switched to a different account ${switchCount} times total. Could be a shared family device over time, or someone farming fresh accounts one switch/day — worth a look.\n\n` +
                `Latest account on it: <code>${userId}</code>`
            ).catch(() => {});
        }
    }

    return { ok: true };
}

// Public-safe snippet of the current owner's identity for the block screen —
// never leak balances or internal flags to the blocked visitor.
export async function getOwnerPublicInfo(db, ownerId) {
    const owner = await db.collection('users').findOne(
        { _id: ownerId },
        { projection: { firstName: 1, telegramUsername: 1 } }
    );
    if (!owner) return { id: ownerId, firstName: 'Unknown', telegramUsername: null };
    return { id: ownerId, firstName: owner.firstName || 'User', telegramUsername: owner.telegramUsername !== 'N/A' ? owner.telegramUsername : null };
}
