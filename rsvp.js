/*
 * Easy Reader — moteur RSVP (Rapid Serial Visual Presentation).
 * Découpe le texte en mots, choisit la lettre pivot de chaque mot,
 * calcule la durée d'affichage et dessine une image sur un canvas.
 * Le même code sert à l'aperçu et à l'export vidéo.
 */
(function (global) {
  'use strict';

  const LETTER = /[\p{L}\p{N}]/u;
  const PUNCT_ONLY = /^[\p{P}\p{S}]+$/u;
  const OPENING = /^[«“‘„([{¿¡—–-]+$/u;
  const SENTENCE_END = /[.!?…]["'»”’)\]]*$/u;
  const CLAUSE_END = /[,;:—–]["'»”’)\]]*$/u;
  const NBSP = ' ';

  const THEMES = {
    creme: { bg: '#ECE8DF', glow: '#F8F6F1', ink: '#1B1A18', line: '#A8A193', label: '#45413B', accent: '#A8191F' },
    nuit: { bg: '#111317', glow: '#1D2027', ink: '#EDEBE6', line: '#3B3F47', label: '#9EA3AB', accent: '#FF5A5F' },
    blanc: { bg: '#FFFFFF', glow: '#FFFFFF', ink: '#111111', line: '#CFCFCF', label: '#555555', accent: '#D3141C' },
  };

  const LABEL_FONT = '"Nunito Sans", "Avenir Next", Avenir, system-ui, sans-serif';

  /*
   * Découpe en mots. La ponctuation isolée (« : », « ? », « » ») reste
   * collée au mot voisin, comme en typographie française, pour ne jamais
   * afficher un signe seul à l'écran.
   */
  function tokenize(text) {
    const words = [];
    const paragraphs = String(text || '').normalize('NFC').replace(/\r\n?/g, '\n').split(/\n[ \t]*\n+/);
    for (const para of paragraphs) {
      const start = words.length;
      let carry = '';
      for (const tok of para.split(/\s+/)) {
        if (!tok) continue;
        if (PUNCT_ONLY.test(tok)) {
          if (OPENING.test(tok) || words.length === start) carry += tok + NBSP;
          else words[words.length - 1].text += NBSP + tok;
          continue;
        }
        words.push({ text: carry + tok, paragraphEnd: false });
        carry = '';
      }
      if (words.length > start) {
        if (carry) words[words.length - 1].text += NBSP + carry.trim();
        words[words.length - 1].paragraphEnd = true;
      }
    }
    return words;
  }

  /*
   * Lettre pivot. En mode « optimal », on suit la règle du point de
   * reconnaissance optimal : un peu avant le milieu du mot.
   * 1 lettre → 1re, 2-5 → 2e, 6-9 → 3e, 10-13 → 4e, 14 et plus → 5e.
   */
  function splitWord(text, mode) {
    const chars = Array.from(text);
    let first = -1;
    let last = -1;
    chars.forEach((c, i) => {
      if (LETTER.test(c)) {
        if (first < 0) first = i;
        last = i;
      }
    });
    let p;
    let letters = 0;
    if (first < 0) {
      p = Math.max(0, Math.floor((chars.length - 1) / 2));
    } else {
      letters = last - first + 1;
      const k = mode === 'middle'
        ? Math.floor((letters - 1) / 2)
        : letters <= 1 ? 0 : letters <= 5 ? 1 : letters <= 9 ? 2 : letters <= 13 ? 3 : 4;
      p = first + k;
    }
    return {
      before: chars.slice(0, p).join(''),
      pivot: chars[p] || '',
      after: chars.slice(p + 1).join(''),
      letters,
    };
  }

  /*
   * Chronologie : une entrée par mot avec son début, sa fin et la vitesse
   * affichée. En mode « accélération », le texte est coupé en paliers
   * égaux et la durée par mot diminue de façon linéaire d'un palier à
   * l'autre (250 → 300 → 375 → 500 → 750 mots/min pour 5 paliers).
   */
  function buildTimeline(words, o) {
    const n = words.length;
    const intro = o.intro ?? 800;
    const outro = o.outro ?? 900;
    const steps = Math.max(1, Math.round(o.steps || 1));
    const ramp = o.mode === 'ramp';
    const msFrom = 60000 / (ramp ? o.from : o.wpm);
    const msTo = 60000 / (ramp ? o.to : o.wpm);
    const events = [];
    let t = intro;
    for (let i = 0; i < n; i++) {
      let ms = msFrom;
      if (ramp && steps > 1) {
        const k = Math.min(steps - 1, Math.floor((i * steps) / n));
        ms = msFrom + ((msTo - msFrom) * k) / (steps - 1);
      }
      const text = words[i].text;
      const parts = splitWord(text, o.pivotMode);
      let f = 1;
      if (o.pauses) {
        if (SENTENCE_END.test(text)) f += 1;
        else if (CLAUSE_END.test(text)) f += 0.5;
        if (words[i].paragraphEnd) f += 0.5;
        if (parts.letters > 12) f += 0.4;
        else if (parts.letters > 8) f += 0.2;
      }
      const d = ms * f;
      events.push({ start: t, end: t + d, parts, wpm: Math.round(60000 / ms) });
      t += d;
    }
    const firstWpm = Math.round(60000 / msFrom);
    return {
      events,
      intro,
      duration: n ? t + outro : 0,
      firstWpm,
      lastWpm: n ? events[n - 1].wpm : firstWpm,
      maxWpm: n ? Math.max(...events.map((e) => e.wpm)) : firstWpm,
    };
  }

  /* Index du mot affiché à l'instant t (ms) : -1 avant le premier, n après le dernier. */
  function indexAt(tl, t) {
    const ev = tl.events;
    if (!ev.length || t < ev[0].start) return -1;
    if (t >= ev[ev.length - 1].end) return ev.length;
    let lo = 0;
    let hi = ev.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ev[mid].start <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  function wpmAt(tl, i) {
    if (i < 0) return tl.firstWpm;
    if (i >= tl.events.length) return tl.lastWpm;
    return tl.events[i].wpm;
  }

  function wrapLines(ctx, text, maxWidth, maxLines) {
    const lines = [];
    let line = '';
    for (const w of text.split(/\s+/).filter(Boolean)) {
      const next = line ? line + ' ' + w : w;
      if (line && ctx.measureText(next).width > maxWidth) {
        lines.push(line);
        line = w;
      } else {
        line = next;
      }
    }
    if (line) lines.push(line);
    if (lines.length > maxLines) {
      lines.length = maxLines;
      lines[maxLines - 1] += '…';
    }
    return lines;
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /*
   * Dessine une image complète en coordonnées vidéo (W × H).
   * look : { theme, accent, font, title, showSpeed }
   * index : mot affiché (-1 ou n = bande vide).
   */
  function drawFrame(ctx, W, H, look, tl, index) {
    const c = THEMES[look.theme] || THEMES.creme;
    const b = Math.min(W, H);
    const hasTitle = Boolean(look.title && look.title.trim());
    const cy = H / 2 + (hasTitle ? 0.05 * b : 0);
    const bandH = 0.3 * b;
    const top = cy - bandH / 2;
    const bottom = cy + bandH / 2;
    const orpX = Math.round(W / 2 - 0.1 * b);
    const lw = Math.max(1, Math.round(0.0035 * b));
    const tick = 0.065 * b;

    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, W, H);

    if (c.glow !== c.bg) {
      // Halo diffus derrière le mot : on ne dessine que l'ombre floue d'un
      // rectangle placé hors champ. Les ombres ignorent la transformation du
      // contexte, d'où la mise à l'échelle manuelle.
      const s = Math.abs(ctx.getTransform().a) || 1;
      const off = W * 3;
      ctx.save();
      ctx.shadowColor = c.glow;
      ctx.shadowBlur = 0.08 * b * s;
      ctx.shadowOffsetX = off * s;
      ctx.fillStyle = '#000';
      roundRect(ctx, 0.14 * W - off, top + 0.08 * b, 0.72 * W, bandH - 0.16 * b, 0.05 * b);
      ctx.fill();
      ctx.restore();
    }

    ctx.fillStyle = c.line;
    ctx.fillRect(0, top - lw / 2, W, lw);
    ctx.fillRect(0, bottom - lw / 2, W, lw);
    ctx.fillRect(orpX - lw / 2, top, lw, tick);
    ctx.fillRect(orpX - lw / 2, bottom - tick, lw, tick);

    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    const ev = tl && index >= 0 && index < tl.events.length ? tl.events[index] : null;
    if (ev && ev.parts.pivot) {
      const { before, pivot, after } = ev.parts;
      let size = 0.11 * b;
      ctx.font = `400 ${size}px ${look.font}`;
      let wBefore = ctx.measureText(before).width;
      let wUpTo = ctx.measureText(before + pivot).width;
      let wAll = ctx.measureText(before + pivot + after).width;
      const margin = 0.05 * W;
      const leftNeed = (wBefore + wUpTo) / 2;
      const rightNeed = wAll - leftNeed;
      const scale = Math.min(1, (orpX - margin) / leftNeed, (W - orpX - margin) / rightNeed);
      if (scale < 1) {
        size *= scale;
        ctx.font = `400 ${size}px ${look.font}`;
        wBefore = ctx.measureText(before).width;
        wUpTo = ctx.measureText(before + pivot).width;
      }
      const xHeight = ctx.measureText('x').actualBoundingBoxAscent || size * 0.45;
      const baseline = cy + xHeight / 2;
      const x0 = orpX - (wBefore + wUpTo) / 2;
      ctx.fillStyle = c.ink;
      if (before) ctx.fillText(before, x0, baseline);
      if (after) ctx.fillText(after, x0 + wUpTo, baseline);
      ctx.fillStyle = look.accent || c.accent;
      ctx.fillText(pivot, x0 + wBefore, baseline);
    }

    if (look.showSpeed && tl) {
      ctx.font = `italic 400 ${0.042 * b}px ${LABEL_FONT}`;
      ctx.fillStyle = c.label;
      ctx.textAlign = 'center';
      ctx.fillText(`${wpmAt(tl, index)} mots/min`, W / 2, bottom + 0.11 * b);
    }

    if (hasTitle) {
      const size = 0.06 * b;
      ctx.font = `400 ${size}px ${look.font}`;
      ctx.fillStyle = c.ink;
      ctx.textAlign = 'center';
      const lines = wrapLines(ctx, look.title.trim(), 0.84 * W, 3);
      const lh = size * 1.25;
      let y = top - 0.11 * b - (lines.length - 1) * lh;
      for (const line of lines) {
        ctx.fillText(line, W / 2, y);
        y += lh;
      }
    }
  }

  global.RSVP = { THEMES, LABEL_FONT, tokenize, splitWord, buildTimeline, indexAt, wpmAt, drawFrame };
})(window);
