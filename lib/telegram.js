// lib/telegram.js
//
// সব জায়গায় (checkJoin, taskComplete, withdraw notification, admin bot)
// বারবার একই fetch কোড না লিখে এই helper গুলো শেয়ার করা হচ্ছে।

const BOT_TOKEN = process.env.BOT_TOKEN;

export async function tgApi(method, body) {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return res.json();
}

// User-supplied text (wallet address, username, etc.) must be escaped before it
// goes into a parse_mode:'HTML' message. Without this, a stray "<" makes Telegram
// reject the whole message (the admin never sees the request) or lets the user
// inject their own formatting/links.
export function escHtml(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export const tgSend = (chatId, text, extra = {}) =>
    tgApi('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });

export const tgEdit = (chatId, messageId, text, extra = {}) =>
    tgApi('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', ...extra });

// Telegram rejects editMessageText on a message that was sent as a
// photo (sendPhoto) with "Bad Request: there is no text in the message to
// edit". Photo messages only have a CAPTION, so they need editMessageCaption
// instead. tgApi() doesn't throw on a Telegram-side {ok:false} error (only
// on a network failure), so calling tgEdit on a photo message fails
// completely silently — the caller sees no exception, the message just
// never changes. Use this whenever the message being edited was sent via
// tgSendPhoto (see the bc_confirm handler in api/bot.js for the bug this fixed).
export const tgEditCaption = (chatId, messageId, caption, extra = {}) =>
    tgApi('editMessageCaption', { chat_id: chatId, message_id: messageId, caption, parse_mode: 'HTML', ...extra });

export const tgSendPhoto = (chatId, photo, caption, extra = {}) =>
    tgApi('sendPhoto', { chat_id: chatId, photo, caption, parse_mode: 'HTML', ...extra });

export const tgAnswerCallback = (callbackQueryId, text = '', showAlert = false) =>
    tgApi('answerCallbackQuery', { callback_query_id: callbackQueryId, text, show_alert: showAlert });

// userId-কে CHANNEL/GROUP-এ মেম্বার কিনা চেক করে
//
// this used to fail-safe to `false` on the very first API hiccup
// (rate limit, timeout, transient 5xx from Telegram). checkJoin calls this
// twice (channel + group) and gets called a LOT — the 60s background
// watcher, every manual "I've joined, check now" tap, and the initial
// gate check — so any single Telegram API blip flashed "not joined" at a
// genuinely-joined user. That's the "checkJoin poriborton hoy, kono karon
// chara fail hoy" pattern being reported. Now a single transient failure
// (not-ok response OR thrown error) gets ONE short retry before giving up;
// a real "not a member" status (r.ok true, status genuinely not in the
// list) is trusted immediately on the first try — no need to retry a
// definitive answer.
async function getChatMemberStatus(userId, chatUsername) {
    try {
        const r = await tgApi('getChatMember', { chat_id: chatUsername, user_id: userId });
        if (!r.ok) {
            // Telegram-এর আসল error message log করছি — bot admin থাকলেও fail হলে এখানেই কারণ দেখা যাবে
            // (যেমন: bot ওই chat-এ নেই, username ভুল, ইত্যাদি)
            console.error(`isMember(${userId}, ${chatUsername}) failed:`, r.description);
            return { ok: false };
        }
        return { ok: true, status: r.result?.status };
    } catch (err) {
        console.error(`isMember(${userId}, ${chatUsername}) threw:`, err.message);
        return { ok: false };
    }
}

export async function isMember(userId, chatUsername) {
    let result = await getChatMemberStatus(userId, chatUsername);
    if (!result.ok) {
        await new Promise((resolve) => setTimeout(resolve, 500)); // brief backoff before the one retry
        result = await getChatMemberStatus(userId, chatUsername);
    }
    if (!result.ok) return false; // still failing after retry — fail-safe as before, but now only after two tries
    return ['member', 'administrator', 'creator'].includes(result.status);
}

// আপনার main.html-এ পাওয়া official channel/community
export const OFFICIAL_CHANNEL = '@Newtube_offcial'; // ⚠️ SEASON 3 CHANGE — new official channel, https://t.me/Newtube_offcial
export const COMMUNITY_GROUP = '@newtube_commonity';
// this was pointing at the OLD shared "fruit_cut_payment" channel.
// The post-on-approve code below (api/bot.js wd_approve_) was working fine —
// the bot IS an admin of that old channel too, so it posted successfully
// every time, just to the wrong (old/shared) channel, which is why nothing
// ever showed up in the new https://t.me/Newtube_pay_chennel channel and it
// looked like posting had silently stopped. Now pointed at the real one.
export const PAYMENT_CHANNEL = '@Newtube_pay_chennel'; // https://t.me/Newtube_pay_chennel
// fixed proof-of-payment banner posted with every approved withdrawal
// (see api/bot.js wd_approve_). Swap this URL if you want a different image later.
export const PAYMENT_PROOF_PHOTO = 'https://cdn.phototourl.com/free/2026-08-07-562ff309-be9d-4683-974d-e5a27da44e18.png';
