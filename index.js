/**
 * Find & Replace for SillyTavern
 *
 * Works on any textarea. Tap into a text box and a small magnifier appears at
 * its top-right corner; tap it and a find bar opens directly above that box:
 * type to count matches, step through them with the arrows, replace one, or
 * replace all.
 */
(() => {
    'use strict';

    const NAME = 'Find & Replace';

    const state = {
        bar: null,        // the shared bar element (only one is open at a time)
        ta: null,         // textarea the bar is currently attached to
        findInput: null,
        replaceInput: null,
        countEl: null,
        matches: [],      // [{ start, end }]
        index: -1,        // current match
        armed: false,     // true once the current match has been selected in the textarea
        matchCase: false,
        busy: false,      // true while we edit the textarea ourselves
        floatEl: null,    // the floating magnifier button
        floatTa: null,    // textarea the floating button currently belongs to
        raf: 0,
    };

    const FLOAT_SIZE = 34;
    const FLOAT_INSET = 8;
    const CLOSING_PUNCTUATION = /^[,.;:!?)\]}%'"\u2019\u201d\u2026]/;

    // ------------------------------------------------------------------
    // Matching
    // ------------------------------------------------------------------

    function escapeRegExp(text) {
        return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function findMatches(text, query, matchCase) {
        if (!query) return [];
        const re = new RegExp(escapeRegExp(query), matchCase ? 'g' : 'gi');
        const found = [];
        let m;
        while ((m = re.exec(text)) !== null) {
            found.push({ start: m.index, end: m.index + m[0].length });
        }
        return found;
    }

    /**
     * The text that should actually be inserted for one match.
     * If the matched text starts or ends with spaces and the replacement doesn't,
     * those spaces are kept, so replacing " mom" with "dad" gives " dad".
     * Exceptions: an empty replacement deletes exactly what matched, a match made
     * only of spaces is replaced literally, and a replacement that begins with
     * closing punctuation attaches directly to the previous word.
     */
    function adjustReplacement(matched, rep) {
        if (rep === '' || !matched.trim()) return rep;
        const lead = matched.match(/^ +/)?.[0] ?? '';
        const trail = matched.match(/ +$/)?.[0] ?? '';
        let out = rep;
        if (lead && !/^\s/.test(out) && !CLOSING_PUNCTUATION.test(out)) out = lead + out;
        if (trail && !/\s$/.test(out)) out += trail;
        return out;
    }

    // ------------------------------------------------------------------
    // Editing the textarea
    // ------------------------------------------------------------------

    /**
     * Replace text[start, end) with `text`.
     *
     * Goes through execCommand first so the browser's undo history keeps working
     * (one undo undoes the whole replacement). The browser fires one input event per
     * line it inserts, so those are swallowed and a single input event is sent at the
     * end instead. ST's token counter and other listeners then run once, not once per line.
     * Falls back to setting the value directly if the browser refuses the edit.
     */
    function applyEdit(ta, start, end, text) {
        const before = ta.value;
        const expected = before.slice(0, start) + text + before.slice(end);
        const swallow = (e) => e.stopImmediatePropagation();

        state.busy = true;
        ta.addEventListener('input', swallow, true);
        try {
            ta.focus({ preventScroll: true });
            ta.setSelectionRange(start, end);
            try {
                if (text === '') document.execCommand('delete');
                else document.execCommand('insertText', false, text);
            } catch { /* handled by the check below */ }

            if (ta.value !== expected) ta.value = expected;
            const caret = start + text.length;
            ta.setSelectionRange(caret, caret);
        } finally {
            ta.removeEventListener('input', swallow, true);
            state.busy = false;
        }
        ta.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // ------------------------------------------------------------------
    // Scrolling a match into view
    // ------------------------------------------------------------------

    /** Pixel offset (from the top of the content) of the line holding `offset`. */
    function measureOffsetTop(ta, offset) {
        const cs = getComputedStyle(ta);
        const mirror = document.createElement('div');
        const props = [
            'boxSizing', 'width', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle',
            'letterSpacing', 'lineHeight', 'textTransform', 'textIndent', 'wordSpacing',
            'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
            'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
            'tabSize',
        ];
        for (const p of props) mirror.style[p] = cs[p];
        Object.assign(mirror.style, {
            position: 'absolute',
            visibility: 'hidden',
            top: '0',
            left: '-9999px',
            height: 'auto',
            whiteSpace: 'pre-wrap',
            overflowWrap: 'break-word',
        });
        mirror.textContent = ta.value.slice(0, offset);
        const marker = document.createElement('span');
        marker.textContent = '\u200b';
        mirror.appendChild(marker);
        document.body.appendChild(mirror);
        const top = marker.offsetTop;
        mirror.remove();
        return top;
    }

    function scrollToOffset(ta, offset) {
        const top = measureOffsetTop(ta, offset);

        // Scroll inside the textarea if it has its own scrollbar.
        ta.scrollTop = Math.max(0, top - ta.clientHeight / 2);

        // The textarea may instead be sized to its content, with the form scrolling.
        const form = ta.closest('#form_create');
        if (form) {
            const lineY = ta.getBoundingClientRect().top + top - ta.scrollTop;
            const box = form.getBoundingClientRect();
            const margin = 80;
            if (lineY < box.top + margin || lineY > box.bottom - margin) {
                form.scrollTop += lineY - (box.top + box.height / 3);
            }
        }
    }

    // ------------------------------------------------------------------
    // Bar behaviour
    // ------------------------------------------------------------------

    function updateCount() {
        const n = state.matches.length;
        state.countEl.textContent = n ? `${state.index + 1}/${n}` : '0/0';
    }

    /** Recount matches. With fromCaret, the current match becomes the first one at or after the caret. */
    function refresh({ fromCaret = false } = {}) {
        const ta = state.ta;
        if (!ta) return;
        state.matches = findMatches(ta.value, state.findInput.value, state.matchCase);

        if (!state.matches.length) {
            state.index = -1;
        } else if (fromCaret) {
            const caret = ta.selectionStart ?? 0;
            const i = state.matches.findIndex(m => m.start >= caret);
            state.index = i === -1 ? 0 : i;
            state.armed = false;
        } else {
            state.index = Math.min(Math.max(state.index, 0), state.matches.length - 1);
        }
        updateCount();
    }

    /** Show the current match. Only selects (and focuses) the textarea when asked to, so typing in the find field isn't interrupted. */
    function showMatch(select) {
        const m = state.matches[state.index];
        if (!m) return;
        if (select) {
            state.ta.focus({ preventScroll: true });
            state.ta.setSelectionRange(m.start, m.end);
            state.armed = true;
        }
        scrollToOffset(state.ta, m.start);
    }

    function step(delta) {
        const n = state.matches.length;
        if (!n) return;
        // First press after typing just reveals the current match, like VS Code.
        if (!state.armed && delta > 0 && state.index >= 0) {
            showMatch(true);
            return;
        }
        state.index = (state.index + delta + n) % n;
        updateCount();
        showMatch(true);
    }

    function replaceOne() {
        if (!state.matches.length) return;
        if (!state.armed) {
            showMatch(true);   // show what is about to change before changing it
            return;
        }
        const ta = state.ta;
        const m = state.matches[state.index];
        const rep = adjustReplacement(ta.value.slice(m.start, m.end), state.replaceInput.value);

        applyEdit(ta, m.start, m.end, rep);

        // Continue after the replacement so a replacement containing the query can't loop.
        const caret = m.start + rep.length;
        state.matches = findMatches(ta.value, state.findInput.value, state.matchCase);
        const next = state.matches.findIndex(x => x.start >= caret);
        state.index = state.matches.length ? (next === -1 ? 0 : next) : -1;
        updateCount();
        if (state.index >= 0) showMatch(true);
    }

    function replaceAll() {
        const n = state.matches.length;
        if (!n) return;
        const ta = state.ta;
        const rawRep = state.replaceInput.value;
        const text = ta.value;
        const first = state.matches[0].start;
        const last = state.matches[n - 1].end;

        // Only the span from the first to the last match is rewritten, as one undo step.
        let out = '';
        let cursor = first;
        for (const m of state.matches) {
            out += text.slice(cursor, m.start) + adjustReplacement(text.slice(m.start, m.end), rawRep);
            cursor = m.end;
        }

        applyEdit(ta, first, last, out);
        state.armed = false;
        refresh({ fromCaret: true });
        notify(`Replaced ${n} ${n === 1 ? 'match' : 'matches'}.`);
    }

    function notify(message) {
        if (window.toastr?.info) window.toastr.info(message, NAME);
    }

    // ------------------------------------------------------------------
    // Building and attaching the bar
    // ------------------------------------------------------------------

    function buildBar() {
        const bar = document.createElement('div');
        bar.className = 'fr-bar';
        bar.setAttribute('role', 'search');
        bar.innerHTML = `
            <div class="fr-row">
                <input type="text" class="text_pole fr-find" placeholder="Find" autocomplete="off" autocapitalize="off" spellcheck="false">
                <span class="fr-count">0/0</span>
                <div class="menu_button fa-solid fa-chevron-up" data-fr="prev" title="Previous match"></div>
                <div class="menu_button fa-solid fa-chevron-down" data-fr="next" title="Next match"></div>
                <div class="menu_button fr-case" data-fr="case" title="Match case">Aa</div>
                <div class="menu_button fa-solid fa-xmark" data-fr="close" title="Close"></div>
            </div>
            <div class="fr-row">
                <input type="text" class="text_pole fr-replace" placeholder="Replace with" autocomplete="off" autocapitalize="off" spellcheck="false">
                <div class="menu_button" data-fr="replace" title="Replace this match">Replace</div>
                <div class="menu_button" data-fr="replace-all" title="Replace every match">Replace all</div>
            </div>`;

        // Keep focus where it is when a button is tapped, so the keyboard doesn't flicker.
        bar.addEventListener('mousedown', (e) => {
            if (e.target.closest('.menu_button')) e.preventDefault();
        });

        bar.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-fr]');
            if (!btn) return;
            switch (btn.dataset.fr) {
                case 'prev': step(-1); break;
                case 'next': step(1); break;
                case 'case':
                    state.matchCase = !state.matchCase;
                    btn.classList.toggle('fr-on', state.matchCase);
                    refresh({ fromCaret: true });
                    showMatch(false);
                    break;
                case 'close': closeBar(); break;
                case 'replace': replaceOne(); break;
                case 'replace-all': replaceAll(); break;
            }
        });

        state.findInput = bar.querySelector('.fr-find');
        state.replaceInput = bar.querySelector('.fr-replace');
        state.countEl = bar.querySelector('.fr-count');

        state.findInput.addEventListener('input', () => {
            refresh({ fromCaret: true });
            showMatch(false);
        });

        state.findInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                step(e.shiftKey ? -1 : 1);
            } else if (e.key === 'Escape') {
                closeBar();
            }
        });

        state.replaceInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                replaceOne();
            } else if (e.key === 'Escape') {
                closeBar();
            }
        });

        return bar;
    }

    // Keeps the count right when the text is edited by hand while the bar is open.
    function onTextareaInput() {
        if (state.busy) return;
        refresh({ fromCaret: true });
    }

    function openBar(ta) {
        if (!ta?.isConnected) return;
        if (!state.bar) state.bar = buildBar();
        if (state.ta) state.ta.removeEventListener('input', onTextareaInput);

        state.ta = ta;
        ta.parentElement.insertBefore(state.bar, ta);
        ta.addEventListener('input', onTextareaInput);

        // Selected text in the box becomes the search term.
        const selected = ta.value.slice(ta.selectionStart, ta.selectionEnd);
        const trimmed = selected.trim();
        if (trimmed && trimmed.length <= 100 && !trimmed.includes('\n')) {
            state.findInput.value = trimmed;
        }

        state.matches = [];
        state.index = -1;
        state.armed = false;
        hideFloat();

        refresh({ fromCaret: true });
        state.findInput.focus();
        state.findInput.select();
    }

    function closeBar() {
        if (state.ta) state.ta.removeEventListener('input', onTextareaInput);
        state.bar?.remove();
        state.ta = null;
        state.matches = [];
        state.index = -1;
        state.armed = false;
        // If the box is still focused, offer the floating magnifier again.
        if (isEligible(document.activeElement)) showFloat(document.activeElement);
    }

    function toggleBar(ta) {
        if (state.bar?.isConnected && state.ta === ta) closeBar();
        else openBar(ta);
    }

    // ------------------------------------------------------------------
    // Floating magnifier that follows focus
    // ------------------------------------------------------------------

    /** A textarea the user can type in, big enough to be worth searching, and not the chat input. */
    function isEligible(el) {
        if (!(el instanceof HTMLTextAreaElement)) return false;
        if (el.readOnly || el.disabled || el.id === 'send_textarea') return false;
        if (el.closest('.fr-bar')) return false;
        const r = el.getBoundingClientRect();
        return r.width >= 120 && r.height >= 40;
    }

    /** Dialogs are modal, so the button has to live inside the open one to be tappable. */
    function hostFor(el) {
        return el.closest('dialog[open]') || document.body;
    }

    function buildFloat() {
        const btn = document.createElement('div');
        btn.className = 'menu_button fa-solid fa-magnifying-glass fr-float';
        btn.title = 'Find and replace in this box';
        btn.setAttribute('role', 'button');
        btn.style.display = 'none';

        // Never steal focus from the textarea: the keyboard stays up and nothing else reacts.
        const keepFocus = (e) => { e.preventDefault(); e.stopPropagation(); };
        btn.addEventListener('pointerdown', keepFocus);
        btn.addEventListener('mousedown', keepFocus);
        btn.addEventListener('touchstart', keepFocus, { passive: false });
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (state.floatTa?.isConnected) openBar(state.floatTa);
        });
        return btn;
    }

    function showFloat(ta) {
        if (!isEligible(ta)) return;
        if (state.bar?.isConnected && state.ta === ta) return;   // its bar is already open
        if (!state.floatEl) state.floatEl = buildFloat();
        state.floatTa = ta;
        const host = hostFor(ta);
        if (state.floatEl.parentElement !== host) host.appendChild(state.floatEl);
        state.floatEl.style.display = '';
        positionFloat();
    }

    function hideFloat() {
        state.floatTa = null;
        if (state.floatEl) state.floatEl.style.display = 'none';
    }

    /** The part of the textarea that is actually on screen (not scrolled out of its panel). */
    function visibleRect(ta) {
        const r = ta.getBoundingClientRect();
        let { top, bottom, left, right } = r;
        const vv = window.visualViewport;
        top = Math.max(top, vv ? vv.offsetTop : 0);
        bottom = Math.min(bottom, vv ? vv.offsetTop + vv.height : window.innerHeight);
        left = Math.max(left, 0);
        right = Math.min(right, window.innerWidth);
        for (let p = ta.parentElement; p && p !== document.body; p = p.parentElement) {
            const o = getComputedStyle(p);
            if (o.overflowY === 'visible' && o.overflowX === 'visible') continue;
            const pr = p.getBoundingClientRect();
            top = Math.max(top, pr.top);
            bottom = Math.min(bottom, pr.bottom);
            left = Math.max(left, pr.left);
            right = Math.min(right, pr.right);
        }
        return { top, bottom, left, right };
    }

    function positionFloat() {
        const el = state.floatEl;
        const ta = state.floatTa;
        if (!el || !ta) return;
        if (!ta.isConnected || (state.bar?.isConnected && state.ta === ta)) {
            hideFloat();
            return;
        }
        const v = visibleRect(ta);
        const roomY = v.bottom - v.top;
        const roomX = v.right - v.left;
        if (roomY < FLOAT_SIZE + FLOAT_INSET * 2 || roomX < FLOAT_SIZE + FLOAT_INSET * 2) {
            el.style.visibility = 'hidden';   // scrolled away; comes back when the box does
            return;
        }
        el.style.visibility = '';
        const wantLeft = v.right - FLOAT_SIZE - FLOAT_INSET;
        const wantTop = v.top + FLOAT_INSET;
        el.style.left = `${wantLeft}px`;
        el.style.top = `${wantTop}px`;

        // A transformed ancestor (some popups animate) makes "fixed" relative to it. Correct for that.
        const got = el.getBoundingClientRect();
        const dx = wantLeft - got.left;
        const dy = wantTop - got.top;
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
            el.style.left = `${wantLeft + dx}px`;
            el.style.top = `${wantTop + dy}px`;
        }
    }

    function schedulePosition() {
        if (state.raf) return;
        state.raf = requestAnimationFrame(() => {
            state.raf = 0;
            // The box (or the dialog holding the bar) was removed: tidy up.
            if (state.bar && (!state.ta?.isConnected || !state.bar.isConnected)) closeBar();
            else if (state.bar && state.bar.closest('dialog:not([open])')) closeBar();
            if (state.floatTa) positionFloat();
        });
    }

    function initFloating() {
        document.addEventListener('focusin', (e) => {
            const t = e.target;
            if (t === state.floatEl || state.bar?.contains(t)) return;
            if (isEligible(t)) showFloat(t);
            else hideFloat();
        });

        document.addEventListener('focusout', () => {
            // Wait to see where focus went before hiding.
            setTimeout(() => {
                const a = document.activeElement;
                if (isEligible(a) || state.bar?.contains(a)) return;
                hideFloat();
            }, 0);
        });

        // "close" doesn't bubble, but it can be caught on the way down.
        document.addEventListener('close', schedulePosition, true);
        document.addEventListener('scroll', schedulePosition, { capture: true, passive: true });
        window.addEventListener('resize', schedulePosition);
        window.visualViewport?.addEventListener('resize', schedulePosition);
        window.visualViewport?.addEventListener('scroll', schedulePosition);
        // Typing can grow an auto-sized box.
        document.addEventListener('input', () => { if (state.floatTa) schedulePosition(); }, true);
    }

    function init() {
        initFloating();

        // A different character was opened: drop the old bar.
        try {
            const ctx = window.SillyTavern?.getContext?.();
            const evt = ctx?.event_types?.CHARACTER_EDITOR_OPENED;
            if (ctx?.eventSource && evt) {
                ctx.eventSource.on(evt, () => {
                    closeBar();
                });
            }
        } catch (e) {
            console.warn(`[${NAME}] Could not subscribe to editor events:`, e);
        }

    }

    jQuery(init);
})();
