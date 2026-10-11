// lib/dailyReset.js
//
// race-condition-নিরাপদ daily reset প্যাটার্ন। প্রতিটা "দৈনিক লিমিট" চেক করার আগে
// এই ফাংশন কল করুন — এটা idempotent (একবারের বেশি চললেও সমস্যা নেই) এবং নিজেই
// atomic, তাই দিন বদলানোর মুহূর্তে দুটো রিকোয়েস্ট একসাথে এলেও কাউন্টার ডবল-রিসেট হবে না।

import { dailyResetFields, todayBD } from './constants.js';

export async function ensureDailyReset(users, userId) {
    const today = todayBD();
    // শুধুমাত্র lastResetDate আজকের তারিখ না হলেই রিসেট হবে — অন্যথায় no-op
    await users.updateOne(
        { _id: userId, lastResetDate: { $ne: today } },
        { $set: dailyResetFields() }
    );
    return today;
}
