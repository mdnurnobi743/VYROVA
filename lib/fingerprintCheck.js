// lib/fingerprintCheck.js
//
// একই fingerprint হ্যাশ আগে অন্য কোনো userId-এর সাথে দেখা গিয়েছিল কিনা চেক করে।
//
// ⚠️ SEASON 3 CHANGE — enforcement moved to IP (see lib/ipRegistry.js +
// api/user.js handleInit), which now does the actual blocking on every app
// open, not just at signup. Device-fingerprint auto-ban is turned back OFF
// here on purpose: with IP as the hard gate, auto-suspending on fingerprint
// too would double-punish the same abuse case and reintroduces the same
// shared-device false-positive risk (family/cyber-cafe users) for no extra
// protection. This goes back to its original soft behavior — record the
// match and set multiAccountFlag for admin review only, never touch
// isBanned itself.
//
// COLLECTION: fingerprints
// { _id: "<sha256 hash>", userIds: ["111", "222"], firstSeenAt: Date, lastSeenAt: Date }

export async function checkAndRecordFingerprint(db, userId, fingerprint) {
    if (!fingerprint || typeof fingerprint !== 'string' || fingerprint.length < 16) {
        return { flagged: false }; // fingerprint না পাঠালে silently skip — ব্লক করার কারণ না
    }

    const fingerprints = db.collection('fingerprints');

    // ── ATOMIC upsert: এই হ্যাশ আগে দেখা গিয়েছিল কিনা জানার আগেই userId যুক্ত করে দিন ──
    let doc;
    try {
        doc = await fingerprints.findOneAndUpdate(
            { _id: fingerprint },
            {
                $addToSet: { userIds: userId },
                $set: { lastSeenAt: new Date() },
                $setOnInsert: { firstSeenAt: new Date() },
            },
            { upsert: true, returnDocument: 'before' } // 'before' = upsert-এর আগের অবস্থা, যদি ছিল
        );
    } catch (err) {
        if (err?.code === 11000) {
            // অন্য একটা concurrent রিকোয়েস্ট প্রথমে ডকুমেন্টটা তৈরি করে ফেলেছে — এখন সেটা update করুন
            doc = await fingerprints.findOneAndUpdate(
                { _id: fingerprint },
                { $addToSet: { userIds: userId }, $set: { lastSeenAt: new Date() } },
                { upsert: true, returnDocument: 'before' }
            );
        } else {
            throw err;
        }
    }

    const priorUserIds = doc?.userIds || [];
    const siblings = priorUserIds.filter((id) => id !== userId);

    if (siblings.length > 0) {
        // Soft flag only — for admin review, no auto-ban. IP is the active gate now.
        await db.collection('users').updateOne(
            { _id: userId },
            { $set: { multiAccountFlag: true, multiAccountSiblings: siblings, multiAccountFingerprint: fingerprint } }
        );
        return { flagged: true, siblings };
    }

    return { flagged: false };
}
