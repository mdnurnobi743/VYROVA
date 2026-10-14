# 🛡️ Server Guard (3 layers) — lib/guard.js

| Layer | Kothay | Ki kore | DB lage? |
|---|---|---|---|
| 1 Gate | RAM | body size, IP burst (60 req/10s), fake/invalid initData → 401, blocked IP/user → 429 | ❌ na |
| 2 Counter | MongoDB `rateLimits` | per-user 90 req/min, per-IP 300 req/min (soft = 429) | ✅ 1-2 op |
| 3 Ban hammer | MongoDB `rateBlocks` | hard limit (user 180/min, IP 900/min) ba soft-limit-er pore hammering → block 10m → 1h → 6h → 24h, admin-ke alert + 🔓 Unblock button | rare |

- Webhook (api/bot.js): ek user 40 msg/min-er beshi dile silently drop (200, kono reply na), 120/min-e block.
- Admin / TASK_MODERATOR kokhono throttle hoy na.
- DB error hole guard "fail open" kore — guard-er bug bot-ke kokhono dead korbe na.
- Limit change korte chaile Vercel env: GUARD_USER_SOFT, GUARD_USER_HARD, GUARD_IP_SOFT, GUARD_IP_HARD, GUARD_BOT_SOFT, GUARD_BOT_HARD, GUARD_IP_MEM_PER_10S (kono env na dile default cholbe).
- Deploy-er por ekbar `/api/admin/setup-indexes?secret=<BOT_TOKEN>` kholo (TTL index; na kholleo guard nijei bananor chesta kore).
