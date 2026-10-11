// lib/mongodb.js
//
// এই ফাইলটা Vercel serverless function এর জন্য MongoDB connection বানায়।
// Vercel এ প্রতিটা API call নতুন function invocation হতে পারে, তাই বারবার
// connect না করে cached connection reuse করা হয় — এটা না করলে MongoDB
// Atlas এর connection limit শেষ হয়ে যাবে।
//
// ব্যবহার (যেকোনো /api ফাইলে):
//   import { connectToDatabase } from '../lib/mongodb.js';
//   const { db } = await connectToDatabase();
//   const usersCollection = db.collection('users');

import { MongoClient } from 'mongodb';

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB  = process.env.MONGODB_DB || 'newtube';

if (!MONGODB_URI) {
    throw new Error(
        'MONGODB_URI environment variable টা সেট করা নেই। ' +
        'Vercel Dashboard > Project Settings > Environment Variables এ যোগ করুন, ' +
        'অথবা লোকাল টেস্টের জন্য .env.local ফাইলে রাখুন।'
    );
}

// global cache — serverless cold-start এর মধ্যে connection reuse করার জন্য
let cached = global._mongoCached;
if (!cached) {
    cached = global._mongoCached = { conn: null, promise: null };
}

export async function connectToDatabase() {
    if (cached.conn) {
        return cached.conn;
    }

    if (!cached.promise) {
        const client = new MongoClient(MONGODB_URI, {
            maxPoolSize: 10,
            serverSelectionTimeoutMS: 8000,
        });

        cached.promise = client.connect().then((client) => {
            const db = client.db(MONGODB_DB);
            return { client, db };
        });
    }

    try {
        cached.conn = await cached.promise;
    } catch (e) {
        cached.promise = null; // ফেইল করলে পরের রিকোয়েস্টে আবার ট্রাই করবে
        throw e;
    }

    return cached.conn;
}
