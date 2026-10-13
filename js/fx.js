/* ═══════════════════════════════════════════════════════════════════════════
   VYROVA — visual effects layer (no business logic lives here)
   • atmosphere   : drifting clouds, light beam, champagne motes, scroll parallax
   • coin         : 3D V-coin + flat coin markup builders, tap-to-flip
   • micro        : press ripples + Telegram haptics, tab entrance helper,
                    sliding dock indicator, balance font-fit, splash progress
   Everything here is transform/opacity only, pauses when the app is hidden
   or an element is off-screen, and degrades to nothing under
   prefers-reduced-motion. Exposed as window.VyFX.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    var tg = window.Telegram && window.Telegram.WebApp;
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var lowEnd = (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 4) <= 2;
    var root = document.documentElement;
    if (lowEnd) root.classList.add('lite');

    /* ── haptics ─────────────────────────────────────────────────────────── */
    function haptic(kind) {
        try {
            var h = tg && tg.HapticFeedback;
            if (!h) return;
            if (kind === 'success' || kind === 'error' || kind === 'warning') h.notificationOccurred(kind);
            else if (kind === 'select') h.selectionChanged();
            else h.impactOccurred(kind || 'light');
        } catch (e) { /* older Telegram clients */ }
    }

    /* ── coin markup ─────────────────────────────────────────────────────── */
    // Gradients/symbols (#vyRim, #vyFace, #vy-v-coin …) live in the sprite at the top of index.html.
    function faceSVG() {
        return '<svg viewBox="0 0 200 200" aria-hidden="true" focusable="false">' +
            '<circle cx="100" cy="100" r="99" fill="url(#vyRim)"/>' +
            '<circle cx="100" cy="100" r="92" fill="url(#vyRimIn)"/>' +
            '<circle cx="100" cy="100" r="86.5" fill="none" stroke="rgba(120,96,40,.35)" stroke-width="1"/>' +
            '<circle cx="100" cy="100" r="84" fill="url(#vyFace)"/>' +
            '<circle cx="100" cy="100" r="76" fill="none" stroke="rgba(255,255,255,.38)" stroke-width="1.6" stroke-dasharray="1.2 5.4" stroke-linecap="round"/>' +
            '<circle cx="100" cy="100" r="84" fill="none" stroke="rgba(10,30,18,.35)" stroke-width="1.5"/>' +
            '<use href="#vy-v-coin" x="44" y="42" width="112" height="112"/>' +
            '<ellipse cx="78" cy="58" rx="58" ry="30" transform="rotate(-30 78 58)" fill="url(#vyGloss)"/>' +
            '<path d="M24 82 A80 80 0 0 1 96 22" stroke="rgba(255,255,255,.75)" stroke-width="2.4" stroke-linecap="round" fill="none" opacity=".7"/>' +
            '</svg>';
    }
    function coinFlat(size) {
        var s = size ? ' width="' + size + '" height="' + size + '"' : '';
        return '<svg class="coin-flat" viewBox="0 0 200 200"' + s + ' aria-hidden="true" focusable="false">' + faceSVG().replace(/^<svg[^>]*>|<\/svg>$/g, '') + '</svg>';
    }
    function coin3d(opts) {
        opts = opts || {};
        var slices = '';
        for (var z = -7; z <= 7; z += 1.75) slices += '<i style="--z:' + z + 'px"></i>';
        var style = opts.size ? ' style="--coin-size:' + opts.size + 'px"' : '';
        return '<div class="coin3d" data-coin role="img" aria-label="VYRO COIN"' + style + '>' +
            '<div class="coin3d-float"><div class="coin3d-tap"><div class="coin3d-body">' +
            '<div class="coin-edge">' + slices + '</div>' +
            '<div class="coin-face front">' + faceSVG() + '<i class="coin-sheen"></i></div>' +
            '<div class="coin-face back">' + faceSVG() + '<i class="coin-sheen"></i></div>' +
            '</div></div></div></div>';
    }
    function leaf(cls) { return '<svg class="coin-leaf ' + cls + '" viewBox="0 0 40 40" aria-hidden="true"><use href="#vy-leaf"/></svg>'; }

    function flipCoin(coin) {
        if (reduce) return;
        var tap = coin.querySelector('.coin3d-tap');
        if (!tap || tap.getAnimations().length) return;
        haptic('medium');
        tap.animate(
            [{ transform: 'rotateY(0deg)' }, { transform: 'rotateY(720deg)' }],
            { duration: 1400, easing: 'cubic-bezier(.2,.75,.15,1)' }
        );
    }
    function flipFlat(el) {
        if (reduce || !el || el.getAnimations().length) return;
        haptic('medium');
        el.animate(
            [{ transform: 'perspective(420px) rotateY(0deg)' }, { transform: 'perspective(420px) rotateY(360deg)' }],
            { duration: 900, easing: 'cubic-bezier(.3,.7,.2,1)' }
        );
    }

    /* ── atmosphere ──────────────────────────────────────────────────────── */
    var layers = [];
    function mountAtmosphere() {
        if (document.getElementById('atmosphere')) return;
        var el = document.createElement('div');
        el.id = 'atmosphere';
        el.setAttribute('aria-hidden', 'true');
        el.innerHTML =
            '<div class="atm-beam"></div>' +
            '<div class="atm-layer" data-depth="0.025"><i class="cloud c1"></i><i class="cloud c2"></i></div>' +
            '<div class="atm-layer" data-depth="0.055"><i class="cloud c6"></i><i class="cloud c3"></i></div>' +
            '<div class="atm-layer" data-depth="0.1"><i class="cloud c4"></i><i class="cloud c5"></i></div>';
        var motes = reduce ? 0 : (lowEnd ? 0 : 6);
        for (var i = 0; i < motes; i++) {
            var m = document.createElement('i');
            var dur = 20 + Math.random() * 18;
            var size = 3 + Math.random() * 5;
            m.className = 'mote';
            m.style.cssText = 'left:' + (4 + Math.random() * 92).toFixed(1) + '%;width:' + size.toFixed(1) + 'px;height:' + size.toFixed(1) +
                'px;--dur:' + dur.toFixed(1) + 's;--del:-' + (Math.random() * dur).toFixed(1) + 's;--dx:' + ((Math.random() - 0.5) * 70).toFixed(0) + 'px';
            el.appendChild(m);
        }
        document.body.insertBefore(el, document.body.firstChild);
        layers = Array.prototype.map.call(el.querySelectorAll('.atm-layer'), function (n) { return { el: n, d: parseFloat(n.dataset.depth) || 0 }; });
    }

    /* scroll parallax — one rAF per scroll burst, writes transforms only */
    var parallaxEls = [], sy = 0, ticking = false;
    function applyParallax() {
        ticking = false;
        for (var j = 0; j < parallaxEls.length; j++) parallaxEls[j].el.style.transform = 'translate3d(0,' + (sy * parallaxEls[j].f).toFixed(1) + 'px,0)';
    }
    // Parallax is only kept for the hero coin; the cloud layers no longer move with scroll
    // (6 big gradient layers re-composited every frame was the main cause of scroll jank).
    var scrollTimer = 0, scrolling = false;
    function onScroll() {
        if (!scrolling) { scrolling = true; root.classList.add('is-scrolling'); }
        clearTimeout(scrollTimer);
        scrollTimer = setTimeout(function () { scrolling = false; root.classList.remove('is-scrolling'); }, 140);
        if (!parallaxEls.length) return;
        sy = window.pageYOffset || 0;
        if (!ticking) { ticking = true; requestAnimationFrame(applyParallax); }
    }

    /* pause coins that are scrolled out of view */
    var io = ('IntersectionObserver' in window) ? new IntersectionObserver(function (entries) {
        entries.forEach(function (e) { e.target.classList.toggle('is-off', !e.isIntersecting); });
    }, { threshold: 0 }) : null;

    function refresh() {
        parallaxEls = Array.prototype.map.call(document.querySelectorAll('[data-parallax]'), function (n) { return { el: n, f: parseFloat(n.dataset.parallax) || 0 }; });
        if (io) document.querySelectorAll('.coin3d').forEach(function (c) { io.observe(c); });
        if (!reduce) applyParallax();
    }

    /* ── micro-interactions ──────────────────────────────────────────────── */
    var RIPPLE_SEL = '.btn, .nav-item, .row-card, .home-row, .jg-link-card, .pf-row, .pf-cta';
    function onPointerDown(e) {
        var t = e.target.closest ? e.target.closest(RIPPLE_SEL + ', .act, .icon-btn, .lvl, .subnav-btn') : null;
        if (!t) return;
        if (t.matches('.btn, .nav-item, .row-card, .home-row, .subnav-btn, .act, .icon-btn, .pf-row, .pf-cta')) haptic('light');
        if (reduce || !t.matches(RIPPLE_SEL) || t.disabled) return;
        var r = t.getBoundingClientRect();
        var d = Math.max(r.width, r.height) * 2;
        var s = document.createElement('span');
        s.className = 'rip';
        s.style.cssText = 'width:' + d + 'px;height:' + d + 'px;left:' + (e.clientX - r.left - d / 2) + 'px;top:' + (e.clientY - r.top - d / 2) + 'px';
        t.appendChild(s);
        setTimeout(function () { s.remove(); }, 700);
    }
    function onClick(e) {
        var c = e.target.closest && e.target.closest('.coin3d');
        if (c) { flipCoin(c); return; }
        var n = e.target.closest && e.target.closest('.nav-coin');
        if (n) flipFlat(n.querySelector('.nav-coin-body'));
    }

    /* slide the dock indicator under the active tab */
    function moveNavIndicator() {
        var nav = document.querySelector('.bottomnav');
        if (!nav) return;
        var ind = nav.querySelector('.nav-indicator');
        var act = nav.querySelector('.nav-item.active');
        if (!ind) return;
        if (!act) { ind.classList.add('off'); return; }
        var nr = nav.getBoundingClientRect(), ar = act.getBoundingClientRect();
        ind.classList.remove('off');
        ind.style.setProperty('--nx', (ar.left - nr.left + ar.width / 2 - 11).toFixed(1) + 'px');
    }

    /* restart the entrance animation of #tab-content (dir: 1 = from right, -1 = from left, 0 = none) */
    function enterTab(host, dir) {
        if (!host) return;
        host.classList.remove('tab-enter', 'from-left', 'from-right');
        host.querySelectorAll('[data-stagger]').forEach(function (n) { n.removeAttribute('data-stagger'); });
        if (reduce) return;
        void host.offsetWidth; // restart
        host.classList.add('tab-enter');
        if (dir) host.classList.add(dir < 0 ? 'from-left' : 'from-right');
        // stagger the first level that actually has several blocks, unless the screen has its own anim-in choreography
        var h = host;
        while (h.children.length === 1) h = h.firstElementChild;
        if (!h.children.length || h.querySelector(':scope > [class*="anim-in"]')) return;
        h.setAttribute('data-stagger', '');
        Array.prototype.forEach.call(h.children, function (c, i) { c.style.setProperty('--i', Math.min(i, 8)); });
    }

    /* shrink the balance font until it fits beside the coin */
    function fitNumber(el, max, min) {
        if (!el) return;
        var s = max || 48, floor = min || 26;
        el.style.fontSize = s + 'px';
        while (el.scrollWidth > el.clientWidth + 1 && s > floor) { s -= 2; el.style.fontSize = s + 'px'; }
    }

    /* ── splash progress ─────────────────────────────────────────────────── */
    var splashRaf = 0, splashPct = 0;
    function splashTick(start) {
        var fill = document.querySelector('.splash-loadbar-fill'), pct = document.querySelector('.splash-loadbar-label .pct');
        if (!fill || !pct) return;
        function step(now) {
            var t = Math.min(1, (now - start) / 2600);
            splashPct = 90 * (1 - Math.pow(1 - t, 3));
            fill.style.width = splashPct.toFixed(1) + '%';
            pct.textContent = Math.round(splashPct) + '%';
            if (t < 1) splashRaf = requestAnimationFrame(step);
        }
        splashRaf = requestAnimationFrame(step);
    }
    function finishSplash() {
        cancelAnimationFrame(splashRaf);
        var fill = document.querySelector('.splash-loadbar-fill'), pct = document.querySelector('.splash-loadbar-label .pct');
        if (fill) fill.style.width = '100%';
        if (pct) pct.textContent = '100%';
        return new Promise(function (r) { setTimeout(r, reduce ? 0 : 420); });
    }

    /* ── boot ────────────────────────────────────────────────────────────── */
    function boot() {
        mountAtmosphere();
        var sc = document.getElementById('splash-coin');
        if (sc) { sc.innerHTML = '<div class="coin-aura"></div>' + coin3d({ size: 170 }); }
        splashTick(performance.now());
        refresh();
        window.addEventListener('scroll', onScroll, { passive: true });
        document.addEventListener('pointerdown', onPointerDown, { passive: true });
        document.addEventListener('click', onClick);
        window.addEventListener('resize', moveNavIndicator);
        window.addEventListener('orientationchange', function () { setTimeout(moveNavIndicator, 250); });
        if (document.fonts && document.fonts.ready) document.fonts.ready.then(moveNavIndicator);
        // battery: freeze every loop while the Mini App is backgrounded
        function setPaused(p) { root.classList.toggle('fx-paused', !!p); }
        document.addEventListener('visibilitychange', function () { setPaused(document.hidden); });
        if (tg && tg.onEvent) { try { tg.onEvent('deactivated', function () { setPaused(true); }); tg.onEvent('activated', function () { setPaused(false); }); } catch (e) { /* ignore */ } }
    }
    if (document.body) boot(); else document.addEventListener('DOMContentLoaded', boot);

    window.VyFX = {
        reduce: reduce, lowEnd: lowEnd, haptic: haptic,
        coin3d: coin3d, coinFlat: coinFlat, leaf: leaf, flipCoin: flipCoin,
        refresh: refresh, enterTab: enterTab, moveNavIndicator: moveNavIndicator, fitNumber: fitNumber, finishSplash: finishSplash,
    };
})();
