/* Easy Reader — interface : texte, réglages, aperçu et export. */
(function () {
  'use strict';

  const { THEMES, LABEL_FONT, tokenize, buildTimeline, indexAt, drawFrame } = window.RSVP;

  const FORMATS = { '9:16': [1080, 1920], '4:5': [1080, 1350], '1:1': [1080, 1080], '16:9': [1920, 1080] };
  const FONTS = {
    classique: { css: '"Tinos", "Times New Roman", Times, serif', family: 'Tinos' },
    livre: { css: '"Literata", Georgia, serif', family: 'Literata' },
    hyperlisible: { css: '"Atkinson Hyperlegible", system-ui, sans-serif', family: 'Atkinson Hyperlegible' },
    aeree: { css: '"Lexend", system-ui, sans-serif', family: 'Lexend' },
  };
  const STORE_KEY = 'easy-reader:v1';

  const SAMPLE = `Quand vous lisez une ligne, vos yeux ne glissent pas : ils sautent. Chaque saut s'appelle une saccade, et entre deux saccades, le regard se pose un court instant sur un mot.

Ici, c'est le mot qui vient à vous. Il apparaît toujours au même endroit, et sa lettre rouge marque le point où votre œil doit se poser. Plus besoin de chercher le début de la ligne suivante : le cerveau n'a plus qu'à reconnaître.

Au début, cela paraît rapide. Puis, au bout de quelques phrases, le rythme devient naturel. Augmentez la vitesse petit à petit et remarquez à quel moment vous commencez à décrocher.

Remplacez ce texte par le vôtre, choisissez une vitesse, puis créez votre vidéo.`;

  const $ = (id) => document.getElementById(id);
  const els = {
    text: $('text'), file: $('file'), clear: $('clear'), stats: $('stats'),
    screen: $('screen'), canvas: $('preview'), play: $('play'), restart: $('restart'), scrub: $('scrub'), clock: $('clock'),
    exportBtn: $('export'), exportMeta: $('export-meta'), progress: $('progress'), bar: $('bar'), barFill: $('bar-fill'),
    progressLabel: $('progress-label'), cancel: $('cancel'), result: $('result'), resultVideo: $('result-video'),
    save: $('save'), share: $('share'), resultName: $('result-name'), resultMeta: $('result-meta'), message: $('message'),
    wpm: $('wpm'), wpmOut: $('wpm-out'), speedFixed: $('speed-fixed'), speedRamp: $('speed-ramp'),
    wpmFrom: $('wpm-from'), wpmTo: $('wpm-to'), steps: $('steps'), rampHint: $('ramp-hint'), pauses: $('pauses'),
    font: $('font'), accent: $('accent'), accentReset: $('accent-reset'), title: $('title'), showSpeed: $('show-speed'),
  };
  const ctx = els.canvas.getContext('2d');

  let settings = null;
  let words = [];
  let timeline = buildTimeline([], { mode: 'fixed', wpm: 300 });
  let accentCustom = false;
  let undoText = null;
  let exporting = null;
  let lastVideo = null;
  const player = { playing: false, t: 0, last: 0, raf: 0, shown: null };

  /* Capacité « downloads » du lecteur claude.ai, absente ailleurs. */
  const downloadsReady = window.claude && typeof window.claude.use === 'function'
    ? window.claude.use('downloads').catch(() => null)
    : Promise.resolve(null);

  /* ---------- Outils ---------- */
  const radio = (name) => document.querySelector(`input[name="${name}"]:checked`).value;
  const setRadio = (name, value) => {
    const el = document.querySelector(`input[name="${name}"][value="${value}"]`);
    if (el) el.checked = true;
  };
  const clampNum = (v, min, max, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.min(max, Math.max(min, n)) : fallback;
  };

  function fmtClock(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  function fmtDuration(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s} s`;
    const r = s % 60;
    return r ? `${Math.floor(s / 60)} min ${r} s` : `${Math.floor(s / 60)} min`;
  }
  function fmtSize(bytes) {
    return bytes > 1e6 ? `${(bytes / 1e6).toFixed(1).replace('.', ',')} Mo` : `${Math.max(1, Math.round(bytes / 1e3))} Ko`;
  }
  function slug(text) {
    return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'texte';
  }
  function setMessage(text) { els.message.textContent = text || ''; }

  /* ---------- Réglages ---------- */
  function readSettings() {
    const theme = radio('theme');
    return {
      mode: radio('mode'),
      wpm: clampNum(els.wpm.value, 100, 1000, 300),
      from: clampNum(els.wpmFrom.value, 60, 1500, 250),
      to: clampNum(els.wpmTo.value, 60, 1500, 750),
      steps: Math.round(clampNum(els.steps.value, 1, 12, 5)),
      pauses: els.pauses.checked,
      format: radio('format'),
      theme,
      font: els.font.value,
      accent: accentCustom ? els.accent.value : THEMES[theme].accent,
      accentCustom,
      pivotMode: radio('pivot'),
      title: els.title.value,
      showSpeed: els.showSpeed.checked,
    };
  }

  function currentLook() {
    return {
      theme: settings.theme,
      accent: settings.accent,
      font: (FONTS[settings.font] || FONTS.classique).css,
      title: settings.title,
      showSpeed: settings.showSpeed,
    };
  }

  function restore() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (_) { saved = null; }
    if (!saved || typeof saved !== 'object') {
      els.text.value = SAMPLE;
      return;
    }
    const s = saved.settings || {};
    els.text.value = typeof saved.text === 'string' ? saved.text : SAMPLE;
    if (s.mode) setRadio('mode', s.mode);
    if (s.wpm) els.wpm.value = s.wpm;
    if (s.from) els.wpmFrom.value = s.from;
    if (s.to) els.wpmTo.value = s.to;
    if (s.steps) els.steps.value = s.steps;
    if (typeof s.pauses === 'boolean') els.pauses.checked = s.pauses;
    if (s.format && FORMATS[s.format]) setRadio('format', s.format);
    if (s.theme && THEMES[s.theme]) setRadio('theme', s.theme);
    if (s.font && FONTS[s.font]) els.font.value = s.font;
    if (s.pivotMode) setRadio('pivot', s.pivotMode);
    if (typeof s.title === 'string') els.title.value = s.title;
    if (typeof s.showSpeed === 'boolean') els.showSpeed.checked = s.showSpeed;
    accentCustom = Boolean(s.accentCustom && /^#[0-9a-f]{6}$/i.test(s.accent || ''));
    if (accentCustom) els.accent.value = s.accent;
  }

  let saveTimer = 0;
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(STORE_KEY, JSON.stringify({ text: els.text.value, settings })); } catch (_) { /* stockage indisponible */ }
    }, 400);
  }

  /* ---------- Reconstruction ---------- */
  function rebuild() {
    settings = readSettings();
    if (!accentCustom) els.accent.value = settings.accent;
    els.speedFixed.hidden = settings.mode !== 'fixed';
    els.speedRamp.hidden = settings.mode !== 'ramp';
    els.wpmOut.textContent = settings.wpm;

    words = tokenize(els.text.value);
    timeline = buildTimeline(words, { ...settings });
    player.t = Math.min(player.t, timeline.duration);
    player.shown = null;

    updateStats();
    sizeCanvas();
    render(true);
    persist();
  }

  function rampSteps() {
    const { from, to, steps } = settings;
    if (steps <= 1) return [Math.round(from)];
    const a = 60000 / from;
    const b = 60000 / to;
    return Array.from({ length: steps }, (_, k) => Math.round(60000 / (a + ((b - a) * k) / (steps - 1))));
  }

  function updateStats() {
    const n = words.length;
    const [W, H] = FORMATS[settings.format];
    if (!n) {
      els.stats.textContent = 'Aucun mot pour l’instant.';
      els.exportMeta.textContent = `${W} × ${H}`;
    } else {
      els.stats.textContent = `${n.toLocaleString('fr-FR')} mot${n > 1 ? 's' : ''} · vidéo de ${fmtDuration(timeline.duration)}`;
      els.exportMeta.textContent = `${W} × ${H} · ${fpsFor(timeline)} images/s · ${fmtDuration(timeline.duration)}`;
    }
    if (settings.mode === 'ramp') {
      els.rampHint.textContent = `Paliers : ${rampSteps().join(' · ')} mots/min`;
    }
  }

  const fpsFor = (tl) => (tl.maxWpm > 400 ? 60 : 30);

  /* ---------- Aperçu ---------- */
  function sizeCanvas() {
    const [W, H] = FORMATS[settings.format];
    const style = getComputedStyle(els.screen);
    const availW = els.screen.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const wide = window.matchMedia('(min-width: 900px)').matches;
    const maxH = Math.max(260, wide ? window.innerHeight - 330 : window.innerHeight * 0.62);
    let cssW = availW;
    let cssH = (cssW * H) / W;
    if (cssH > maxH) {
      cssH = maxH;
      cssW = (cssH * W) / H;
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pw = Math.round(cssW * dpr);
    const ph = Math.round(cssH * dpr);
    els.canvas.style.width = `${Math.round(cssW)}px`;
    els.canvas.style.height = `${Math.round(cssH)}px`;
    if (els.canvas.width !== pw || els.canvas.height !== ph) {
      els.canvas.width = pw;
      els.canvas.height = ph;
      player.shown = null;
    }
  }

  function render(force) {
    const [W, H] = FORMATS[settings.format];
    let i = indexAt(timeline, player.t);
    // À l'arrêt au début, on montre le premier mot plutôt qu'une bande vide.
    if (!player.playing && player.t === 0 && words.length) i = 0;
    if (force || i !== player.shown) {
      ctx.setTransform(els.canvas.width / W, 0, 0, els.canvas.height / H, 0, 0);
      drawFrame(ctx, W, H, currentLook(), timeline, i);
      player.shown = i;
    }
    const d = timeline.duration || 0;
    els.scrub.value = d ? Math.round((player.t / d) * 1000) : 0;
    els.clock.textContent = `${fmtClock(player.t)} / ${fmtClock(d)}`;
  }

  function setPlayUI() {
    els.play.setAttribute('aria-pressed', String(player.playing));
    els.play.setAttribute('aria-label', player.playing ? 'Mettre en pause' : 'Lire l’aperçu');
  }

  function tick(now) {
    if (!player.playing) return;
    player.t += now - player.last;
    player.last = now;
    if (player.t >= timeline.duration) {
      player.t = timeline.duration;
      pause();
      render();
      return;
    }
    render();
    player.raf = requestAnimationFrame(tick);
  }

  function play() {
    if (!timeline.duration) return;
    if (player.t >= timeline.duration) player.t = 0;
    player.playing = true;
    player.last = performance.now();
    setPlayUI();
    player.raf = requestAnimationFrame(tick);
  }

  function pause() {
    player.playing = false;
    cancelAnimationFrame(player.raf);
    setPlayUI();
  }

  /* ---------- Export ---------- */
  function setExportUI(busy) {
    els.exportBtn.disabled = busy;
    els.exportBtn.textContent = busy ? 'Création en cours…' : 'Créer la vidéo MP4';
    els.progress.hidden = !busy;
    document.querySelectorAll('.block-settings input, .block-settings select, .block-settings button, #text, #clear, #file')
      .forEach((el) => { el.disabled = busy; });
  }

  async function fontsReady(look) {
    if (!document.fonts || !document.fonts.load) return;
    const family = (FONTS[settings.font] || FONTS.classique).family;
    try {
      await Promise.all([
        document.fonts.load(`400 64px "${family}"`, 'Aaéè?'),
        document.fonts.load(`italic 400 32px ${LABEL_FONT}`, '300 mots/min'),
      ]);
    } catch (_) { /* police de repli */ }
  }

  async function startExport() {
    if (exporting) return;
    if (!words.length) {
      setMessage('Ajoutez un texte avant de créer la vidéo.');
      els.text.focus();
      return;
    }
    pause();
    const [W, H] = FORMATS[settings.format];
    const fps = fpsFor(timeline);
    const look = currentLook();
    const tl = timeline;
    await fontsReady(look);

    exporting = new AbortController();
    setExportUI(true);
    els.result.hidden = true;
    setMessage('');
    const fast = await window.RSVPVideo.canEncodeFast(W, H, fps);
    if (!fast) setMessage('Ce navigateur enregistre la vidéo en temps réel : gardez cet onglet ouvert et visible jusqu’à la fin.');

    const t0 = performance.now();
    const onProgress = (p) => {
      const pct = Math.floor(p * 100);
      els.barFill.style.width = `${pct}%`;
      els.bar.setAttribute('aria-valuenow', String(pct));
      let label = `${pct} %`;
      const elapsed = performance.now() - t0;
      if (p > 0.03 && p < 1) label += ` · encore ${fmtDuration((elapsed / p) * (1 - p))}`;
      els.progressLabel.textContent = label;
    };
    onProgress(0);

    try {
      const res = await window.RSVPVideo.createVideo({ timeline: tl, look, W, H, fps, signal: exporting.signal, onProgress });
      showResult(res, tl, W, H);
      setMessage('');
    } catch (e) {
      if (e && e.name === 'AbortError') setMessage('Création annulée.');
      else setMessage(`La vidéo n’a pas pu être créée : ${(e && e.message) || e}`);
    } finally {
      exporting = null;
      setExportUI(false);
    }
  }

  function showResult(res, tl, W, H) {
    if (lastVideo && lastVideo.url) URL.revokeObjectURL(lastVideo.url);
    const first = words.slice(0, 5).map((w) => w.text).join(' ');
    const filename = `easy-reader-${slug(first)}-${tl.firstWpm}mpm.${res.ext}`;
    const url = URL.createObjectURL(res.blob);
    lastVideo = { ...res, url, filename };

    els.resultVideo.hidden = false;
    els.resultVideo.src = url;
    els.resultName.textContent = filename;
    els.resultMeta.textContent = `${fmtSize(res.blob.size)} · ${fmtDuration(tl.duration)} · ${W} × ${H}`;
    els.result.hidden = false;

    downloadsReady.then((dl) => {
      let canShare = false;
      try {
        canShare = !dl && typeof navigator.canShare === 'function'
          && navigator.canShare({ files: [new File([res.blob], filename, { type: res.blob.type })] });
      } catch (_) { canShare = false; }
      els.share.hidden = !canShare;
    });
  }

  async function saveVideo() {
    if (!lastVideo) return;
    const dl = await downloadsReady;
    if (dl) {
      try {
        await dl.save({ filename: lastVideo.filename, data: lastVideo.blob });
        setMessage('Vidéo enregistrée.');
      } catch (e) {
        const code = e && e.code;
        if (code === 'declined') setMessage('Enregistrement annulé.');
        else if (code === 'rate_limited') setMessage('Une demande d’enregistrement est déjà ouverte. Réessayez dans un instant.');
        else setMessage('L’enregistrement n’est pas disponible ici.');
      }
      return;
    }
    const a = document.createElement('a');
    a.href = lastVideo.url;
    a.download = lastVideo.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function shareVideo() {
    if (!lastVideo) return;
    try {
      const file = new File([lastVideo.blob], lastVideo.filename, { type: lastVideo.blob.type });
      await navigator.share({ files: [file], title: 'Easy Reader' });
    } catch (e) {
      if (!e || e.name !== 'AbortError') setMessage('Le partage n’est pas disponible ici. Utilisez « Télécharger la vidéo ».');
    }
  }

  /* ---------- Événements ---------- */
  let textTimer = 0;
  els.text.addEventListener('input', () => {
    if (undoText !== null) {
      undoText = null;
      els.clear.textContent = 'Effacer';
    }
    clearTimeout(textTimer);
    textTimer = setTimeout(rebuild, 200);
  });

  els.clear.addEventListener('click', () => {
    pause();
    if (undoText !== null) {
      els.text.value = undoText;
      undoText = null;
      els.clear.textContent = 'Effacer';
    } else {
      undoText = els.text.value;
      els.text.value = '';
      els.clear.textContent = 'Rétablir';
      els.text.focus();
    }
    player.t = 0;
    rebuild();
  });

  els.file.addEventListener('change', () => {
    const f = els.file.files && els.file.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      pause();
      els.text.value = String(reader.result || '');
      player.t = 0;
      rebuild();
      setMessage(`« ${f.name} » importé.`);
    };
    reader.onerror = () => setMessage('Ce fichier n’a pas pu être lu. Choisissez un fichier texte (.txt).');
    reader.readAsText(f);
    els.file.value = '';
  });

  document.querySelector('.block-settings').addEventListener('input', (e) => {
    if (e.target === els.accent) accentCustom = true;
    rebuild();
  });
  els.accentReset.addEventListener('click', () => {
    accentCustom = false;
    rebuild();
  });

  els.play.addEventListener('click', () => (player.playing ? pause() : play()));
  els.restart.addEventListener('click', () => {
    player.t = 0;
    player.shown = null;
    render(true);
  });
  els.scrub.addEventListener('input', () => {
    player.t = (Number(els.scrub.value) / 1000) * timeline.duration;
    if (player.playing) player.last = performance.now();
    render();
  });
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.repeat) return;
    const tag = (e.target && e.target.tagName) || '';
    if (/^(TEXTAREA|INPUT|SELECT|BUTTON)$/.test(tag) || (e.target && e.target.isContentEditable)) return;
    e.preventDefault();
    if (player.playing) pause();
    else play();
  });

  els.exportBtn.addEventListener('click', startExport);
  els.cancel.addEventListener('click', () => exporting && exporting.abort());
  els.save.addEventListener('click', saveVideo);
  els.share.addEventListener('click', shareVideo);
  els.resultVideo.addEventListener('error', () => { els.resultVideo.hidden = true; });

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { sizeCanvas(); render(true); }, 100);
  });

  /* ---------- Démarrage ---------- */
  restore();
  rebuild();
  setPlayUI();
  if (document.fonts && document.fonts.ready) {
    Promise.all(Object.values(FONTS).map((f) => document.fonts.load(`400 64px "${f.family}"`, 'Aa').catch(() => null)))
      .then(() => document.fonts.load(`italic 400 32px ${LABEL_FONT}`, 'mots').catch(() => null))
      .then(() => render(true));
  }
})();
