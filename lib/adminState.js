// lib/adminState.js
//
// রেফারেন্স bot__4_.js এ `const state = {}` দিয়ে in-memory state রাখা হতো —
// এটা Vercel serverless-এ ঝুঁকিপূর্ণ, কারণ প্রতিটা request আলাদা function
// instance-এ যেতে পারে (cold start বা multiple concurrent instance), ফলে
// মাঝপথে state হারিয়ে যেতে পারে (যেমন: Add Task করতে গিয়ে স্টেপ ৩-এ বট
// ভুলে যাবে আগের ২টা স্টেপে কী এন্টার করা হয়েছিল)।
//
// এখানে state MongoDB-তে persist করা হচ্ছে — ছোট একটা collection
// (`adminState`), admin-এর telegram id দিয়ে key করা, তাই serverless
// instance যেটাই হ্যান্ডেল করুক না কেন, state সবসময় ঠিক থাকবে।

import { connectToDatabase } from './mongodb.js';

export async function getAdminState(adminId) {
    const { db } = await connectToDatabase();
    const doc = await db.collection('adminState').findOne({ _id: String(adminId) });
    return doc?.state || null;
}

export async function setAdminState(adminId, state) {
    const { db } = await connectToDatabase();
    await db.collection('adminState').updateOne(
        { _id: String(adminId) },
        { $set: { state, updatedAt: new Date() } },
        { upsert: true }
    );
}

export async function clearAdminState(adminId) {
    const { db } = await connectToDatabase();
    await db.collection('adminState').deleteOne({ _id: String(adminId) });
}
