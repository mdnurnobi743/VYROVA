// lib/telegramAuth.js
//
// গুরুত্বপূর্ণ সিকিউরিটি ফিক্স — আগে backend শুধু client-এর পাঠানো `userId`
// ফিল্ড বিশ্বাস করে নিতো, কোনো ভেরিফিকেশন ছাড়াই। মানে যেকেউ browser
// DevTools থেকে সরাসরি API কল করে অন্য কারো userId বসিয়ে দিতে পারতো এবং
// তার balance/reward নিয়ন্ত্রণ করতে পারতো।
//
// এখন থেকে প্রতিটা request-এ Telegram-এর `initData` (signed string)
// পাঠাতে হবে, এবং সার্ভার Telegram-এর নিজস্ব অফিসিয়াল অ্যালগরিদম দিয়ে
// cryptographically verify করে — bot token ছাড়া কেউ এই signature
// বানাতে পারবে না, তাই userId স্পুফ করা সম্ভব না।
//
// রেফারেন্স: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app

import crypto from 'crypto';

const BOT_TOKEN = process.env.BOT_TOKEN;
const MAX_AUTH_AGE_SECONDS = 86400; // ২৪ ঘণ্টার বেশি পুরোনো session আর valid না (replay-attack ঠেকাতে)

// initData যাচাই করে, সফল হলে { ok: true, user: {...} } ফেরত দেয়,
// fail হলে { ok: false, error: '...' }
export function verifyTelegramInitData(initData) {
    if (!initData || typeof initData !== 'string') {
        return { ok: false, error: 'missing_init_data' };
    }
    if (!BOT_TOKEN) {
        console.error('BOT_TOKEN সেট করা নেই — initData verify করা সম্ভব না');
        return { ok: false, error: 'server_misconfigured' };
    }

    try {
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        if (!hash) return { ok: false, error: 'invalid_init_data' };
        params.delete('hash');

        // Telegram-এর নির্দেশিত অ্যালগরিদম: বাকি সব ফিল্ড key অনুযায়ী sort করে
        // "key=value" আকারে \n দিয়ে জোড়া লাগিয়ে data-check-string বানাতে হয়
        const dataCheckString = Array.from(params.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}=${v}`)
            .join('\n');

        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
        const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

        if (computedHash !== hash) {
            return { ok: false, error: 'invalid_signature' };
        }

        const authDate = parseInt(params.get('auth_date'), 10);
        const ageSeconds = Math.floor(Date.now() / 1000) - authDate;
        if (isNaN(authDate) || ageSeconds > MAX_AUTH_AGE_SECONDS || ageSeconds < -60) {
            return { ok: false, error: 'expired_session' };
        }

        const userJson = params.get('user');
        if (!userJson) return { ok: false, error: 'missing_user' };
        const user = JSON.parse(userJson);

        return { ok: true, user, startParam: params.get('start_param') || null };
    } catch (err) {
        console.error('verifyTelegramInitData error:', err.message);
        return { ok: false, error: 'invalid_init_data' };
    }
}
