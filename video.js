/*
 * Easy Reader — création de la vidéo dans le navigateur.
 * Voie principale : WebCodecs (H.264) + mp4-muxer, plus rapide que le
 * temps réel et à cadence fixe. Repli : MediaRecorder en temps réel.
 */
(function (global) {
  'use strict';

  const { drawFrame, indexAt } = global.RSVP;

  function abortError() {
    return new DOMException('Création annulée', 'AbortError');
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  async function pickEncoderConfig(W, H, fps) {
    if (typeof VideoEncoder !== 'function' || typeof global.Mp4Muxer === 'undefined') return null;
    const avcCodecs = ['avc1.64002A', 'avc1.4D002A', 'avc1.42002A', 'avc1.640033', 'avc1.640028'];
    // Qualité constante quand le navigateur la propose : sinon l'encodeur part
    // d'une qualité trop basse sur la première image. À défaut, débit généreux
    // (les images fixes se compressent de toute façon très bien).
    const bitrate = fps > 30 ? 12_000_000 : 8_000_000;
    const candidates = [
      ...avcCodecs.map((codec) => ({ muxer: 'avc', quantizer: 20, config: { codec, avc: { format: 'avc' }, bitrateMode: 'quantizer' } })),
      ...avcCodecs.map((codec) => ({ muxer: 'avc', config: { codec, avc: { format: 'avc' }, bitrate } })),
      { muxer: 'vp9', config: { codec: 'vp09.00.40.08', bitrate } },
      { muxer: 'av1', config: { codec: 'av01.0.08M.08', bitrate } },
    ];
    for (const c of candidates) {
      const config = { ...c.config, width: W, height: H, framerate: fps, latencyMode: 'quality' };
      try {
        const res = await VideoEncoder.isConfigSupported(config);
        if (res.supported) return { muxer: c.muxer, quantizer: c.quantizer, config };
      } catch (_) {
        /* configuration refusée : on essaie la suivante */
      }
    }
    return null;
  }

  async function encodeWebCodecs({ timeline, look, W, H, fps, signal, onProgress }, enc) {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d', { alpha: false });

    const muxer = new global.Mp4Muxer.Muxer({
      target: new global.Mp4Muxer.ArrayBufferTarget(),
      video: { codec: enc.muxer, width: W, height: H, frameRate: fps },
      fastStart: 'in-memory',
      firstTimestampBehavior: 'offset',
    });
    let failure = null;
    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => { failure = e; },
    });
    encoder.configure(enc.config);

    const total = Math.max(1, Math.ceil((timeline.duration / 1000) * fps));
    const frameUs = 1e6 / fps;
    let shownIndex = null;
    let source = null;
    try {
      for (let n = 0; n < total; n++) {
        if (signal.aborted) throw abortError();
        if (failure) throw failure;
        const i = indexAt(timeline, (n * 1000) / fps);
        if (i !== shownIndex) {
          drawFrame(ctx, W, H, look, timeline, i);
          if (source) source.close();
          source = new VideoFrame(canvas, { timestamp: 0 });
          shownIndex = i;
        }
        const frame = new VideoFrame(source, { timestamp: Math.round(n * frameUs), duration: Math.round(frameUs) });
        const opts = { keyFrame: n % (fps * 2) === 0 };
        if (enc.quantizer) opts.avc = { quantizer: enc.quantizer };
        encoder.encode(frame, opts);
        frame.close();
        while (encoder.encodeQueueSize > 6) {
          if (failure) throw failure;
          await wait(1);
        }
        if (n % 20 === 0) {
          onProgress(n / total);
          await wait(0);
        }
      }
      await encoder.flush();
      if (failure) throw failure;
      muxer.finalize();
    } finally {
      if (source) source.close();
      if (encoder.state !== 'closed') encoder.close();
    }
    onProgress(1);
    return { blob: new Blob([muxer.target.buffer], { type: 'video/mp4' }), ext: 'mp4' };
  }

  async function recordRealtime({ timeline, look, W, H, fps, signal, onProgress }) {
    if (typeof MediaRecorder !== 'function') return null;
    const canvas = document.createElement('canvas');
    if (typeof canvas.captureStream !== 'function') return null;
    const mime = ['video/mp4;codecs=avc1.640028', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm']
      .find((m) => MediaRecorder.isTypeSupported(m));
    if (!mime) return null;

    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d', { alpha: false });
    drawFrame(ctx, W, H, look, timeline, -1);
    const stream = canvas.captureStream(fps);
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 5_000_000 });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise((r) => { rec.onstop = r; });
    rec.start(1000);

    const t0 = performance.now();
    let shown = null;
    try {
      while (true) {
        if (signal.aborted) throw abortError();
        const t = performance.now() - t0;
        const i = indexAt(timeline, t);
        if (i !== shown) {
          drawFrame(ctx, W, H, look, timeline, i);
          shown = i;
        }
        onProgress(Math.min(1, t / timeline.duration));
        if (t >= timeline.duration) break;
        await wait(Math.min(8, 1000 / fps / 2));
      }
    } finally {
      rec.stop();
      stream.getTracks().forEach((tr) => tr.stop());
    }
    await stopped;
    const type = mime.split(';')[0];
    return { blob: new Blob(chunks, { type }), ext: type === 'video/mp4' ? 'mp4' : 'webm', realtime: true };
  }

  /* Renvoie { blob, ext } ou lève une erreur. */
  async function createVideo(opts) {
    const enc = await pickEncoderConfig(opts.W, opts.H, opts.fps);
    if (enc) return encodeWebCodecs(opts, enc);
    const res = await recordRealtime(opts);
    if (res) return res;
    throw new Error('ce navigateur ne sait pas encoder de vidéo. Essayez avec Chrome, Edge ou Safari à jour.');
  }

  async function canEncodeFast(W, H, fps) {
    return Boolean(await pickEncoderConfig(W, H, fps));
  }

  global.RSVPVideo = { createVideo, canEncodeFast };
})(window);
