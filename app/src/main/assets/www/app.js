/* DePDF — UI logic. The PDF work itself runs in worker.js (PyMuPDF via WebAssembly). */
"use strict";

(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  // Set when running inside the Android app (WebView); null in a normal browser/PWA.
  const NATIVE = window.AndroidBridge || null;

  /* ------------------------------------------------------------------ *
   * Defaults: identical to the desktop tool.                           *
   * ------------------------------------------------------------------ */
  const LITE_AUTO = (navigator.deviceMemory || 8) <= 2 || (navigator.hardwareConcurrency || 8) <= 4;
  const DEFAULTS = {
    top: "0", bottom: "0", regions: "", v: 3,
    header: "", footer: "",
    watermark: "", imgWm: true, xrefs: "",
    meta: true, annots: false, links: false, extras: false, hidden: false,
    autoUpdate: false,
    theme: "eraser", accent: 0, lite: LITE_AUTO,
  };
  const STORE_KEY = "pdfcleaner.settings.v1";

  const el = {
    boot: $("#boot"), bootStage: $("#boot-stage"), bootBar: $("#boot-bar"), bootNote: $("#boot-note"), bootRetry: $("#boot-retry"),
    app: $("#app"), bar: $("#actionbar"), pill: $("#pill"), pillText: $("#pill-text"),
    fileInput: $("#file-input"), batchInput: $("#batch-input"),
    top: $("#top"), topRange: $("#top-range"), bottom: $("#bottom"), bottomRange: $("#bottom-range"), regions: $("#regions"),
    header: $("#header-text"), footer: $("#footer-text"), watermark: $("#watermark"), imgWm: $("#img-wm"), xrefs: $("#xrefs"),
    meta: $("#opt-meta"), annots: $("#opt-annots"), links: $("#opt-links"), extras: $("#opt-extras"), hidden: $("#opt-hidden"),
    reset: $("#reset-btn"),
    prevCard: $("#card-preview"), stage: $("#stage"), prevImg: $("#prev-img"), overlay: $("#overlay"), stageMsg: $("#stage-msg"),
    pgPrev: $("#pg-prev"), pgNext: $("#pg-next"), pgLabel: $("#pg-label"), draw: $("#draw-btn"), seg: $("#seg-src"),
    report: $("#report"), outputs: $("#outputs"), chips: $("#xref-chips"), copy: $("#copy-report"),
    status: $("#status"), busyBar: $("#busybar"),
    btnAnalyze: $("#btn-analyze"), btnClean: $("#btn-clean"), btnBatch: $("#btn-batch"), btnUnlock: $("#btn-unlock"),
    toast: $("#toast"),
    ovl: $("#busy"), ovlTitle: $("#busy-title"), ovlDetail: $("#busy-detail"), ovlProg: $("#busy-prog"), ovlFill: $("#busy-prog-fill"),
    ovlPct: $("#busy-pct"), ovlEta: $("#busy-eta"), ovlElapsed: $("#busy-elapsed"), ovlNote: $("#busy-note"), ovlNoteText: $("#busy-note-text"),
    updCard: $("#card-update"), appVer: $("#app-ver"), updStatus: $("#upd-status"), updCheck: $("#upd-check"), updCheckLabel: $("#upd-check-label"),
    updGet: $("#upd-get"), updGetLabel: $("#upd-get-label"), updNotes: $("#upd-notes"), autoUpd: $("#opt-autoupd"), lite: $("#opt-lite"),
    updTop: $("#upd-top"), updTopTitle: $("#upd-top-title"),
  };

  // Thresholds for "this may take a while" notes.
  const SC = (navigator.deviceMemory || 4) <= 2 ? 0.5 : (navigator.deviceMemory || 4) <= 4 ? 0.75 : 1;
  const BIG_PAGES = Math.round(150 * SC), HUGE_PAGES = Math.round(500 * SC), BIG_MB = Math.round(30 * SC), HUGE_MB = Math.round(80 * SC);
  const BATCH_FILES = 5, BATCH_MB = Math.round(60 * SC);
  const MAX_MB = Math.round(250 * SC), MAX_PAGES = Math.round(3000 * SC), MAX_BATCH_FILES = 50, MAX_BATCH_MB = Math.round(600 * SC);
  const MB = 1048576;

  const state = {
    ready: false, busy: false,
    file: null, inPath: null, pages: 0, locked: false,
    cleanPath: null, cleanName: null,
    previewSrc: "orig", page: 0,
    pageW: 595, pageH: 842,
    drawing: false, hf: false, pw: "", unlocked: false, ucKey: null, stash: null, itemIdx: null, itemMode: false, globalSnap: null, engineGen: 0, outputs: [], previewToken: 0, previewUrl: null,
    batch: null,
  };

  /* ------------------------------------------------------------------ *
   * Small helpers                                                      *
   * ------------------------------------------------------------------ */
  let toastTimer = 0;
  function toast(msg, isErr = false) {
    el.toast.textContent = msg;
    el.toast.classList.toggle("err", isErr);
    el.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove("show"), isErr ? 5200 : 2600);
  }
  const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");
  const stemOf = (name) => name.replace(/\.[^.]*$/, "");
  const safeName = (name) => name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_");
  const tidyPaths = (t) => t.replace(/\/(?:in|out)\/[^/\n]+\//g, "");
  /* Loading overlay: shown for every process (after a short delay so quick steps don't flash). */
  const ovl = { delay: 0, tick: 0, t0: 0, pageFrac: null, pct: null, guess: 0, useEta: false, last: 0 };
  const fmtTime = (ms) => { const s = Math.floor(ms / 1000); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
  const SPP_KEY = "pdfcleaner.spp";
  const getSpp = () => { try { return Number(localStorage.getItem(SPP_KEY)) || 0; } catch (e) { return 0; } };
  function learnSpeed(pages, seconds) {
    if (!pages || seconds < 1) return;
    const cur = getSpp(), v = seconds / pages;
    try { localStorage.setItem(SPP_KEY, String(cur ? cur * 0.6 + v * 0.4 : v)); } catch (e) { /* ignore */ }
  }
  function fmtEta(sec) {
    if (sec < 10) return "A few seconds left";
    if (sec < 60) return "About " + Math.round(sec / 5) * 5 + " s left";
    let m = Math.floor(sec / 60), r = Math.round((sec % 60) / 10) * 10;
    if (r === 60) { m++; r = 0; }
    return "About " + m + " min" + (r ? " " + r + " s" : "") + " left";
  }
  function etaText() {
    if (!ovl.useEta) return "";
    const el_s = (Date.now() - ovl.t0) / 1000;
    if (Date.now() - ovl.last > 45000) return "Still working…";
    if (ovl.pct != null && ovl.pct >= 99) return "Finishing…";
    if (ovl.pct != null && ovl.pct >= 6 && el_s >= 3) return fmtEta((el_s * (100 - ovl.pct)) / ovl.pct);
    if (ovl.guess) { const rem = ovl.guess - el_s; return rem > 3 ? fmtEta(rem) : "Almost done"; }
    return "Estimating…";
  }
  function startEta(guessSeconds) { ovl.useEta = true; ovl.guess = guessSeconds || 0; $("#busy-cancel").hidden = false; $("#busy-cancel").disabled = false; el.ovlEta.textContent = etaText(); }
  function setProgress(pct) {
    ovl.pct = pct;
    if (pct == null) { el.ovlProg.classList.add("indet"); el.ovlFill.style.width = ""; el.ovlProg.removeAttribute("aria-valuenow"); el.ovlPct.textContent = ""; return; }
    const v = Math.max(0, Math.min(100, Math.round(pct)));
    el.ovlProg.classList.remove("indet"); el.ovlFill.style.width = v + "%";
    el.ovlProg.setAttribute("aria-valuenow", String(v)); el.ovlPct.textContent = v + "%";
  }
  function showOverlay(title, note) {
    clearTimeout(ovl.delay); clearInterval(ovl.tick);
    ovl.t0 = Date.now(); ovl.pageFrac = null; ovl.pct = null; ovl.guess = 0; ovl.useEta = false; ovl.last = Date.now();
    el.ovlEta.textContent = ""; $("#busy-cancel").hidden = true;
    el.ovlTitle.textContent = title || "Working…";
    el.ovlDetail.textContent = "Starting…";
    el.ovlElapsed.textContent = "0:00";
    setProgress(null);
    el.ovlNote.hidden = !note; el.ovlNoteText.textContent = note || "";
    ovl.delay = setTimeout(() => {
      el.ovl.hidden = false;
      ovl.tick = setInterval(() => { el.ovlElapsed.textContent = fmtTime(Date.now() - ovl.t0); el.ovlEta.textContent = etaText(); }, 1000);
    }, 350);
  }
  function hideOverlay() { clearTimeout(ovl.delay); clearInterval(ovl.tick); el.ovl.hidden = true; }

  function setStatus(t) {
    el.status.textContent = t;
    if (!state.busy) return;
    ovl.last = Date.now();
    const m = /page (\d+) of (\d+)/i.exec(t);
    if (m) { const now = performance.now(); if (now - (ovl.w || 0) < 120) return; ovl.w = now; }
    el.ovlDetail.textContent = tidyPaths(t);
    if (m) {
      const f = (+m[1]) / Math.max(1, +m[2]);
      const b = state.batch;
      setProgress(b ? ((b.i - 1 + f) / b.n) * 100 : f * 100);
    } else if (state.batch) {
      setProgress(((state.batch.i - 1) / state.batch.n) * 100);
    }
  }

  /* Notes for big jobs */
  const isBigFile = (file, pages) => !!file && (pages >= BIG_PAGES || file.size >= BIG_MB * MB);
  function bigFileNote(file, pages) {
    if (!isBigFile(file, pages)) return "";
    const what = (pages ? pages + " pages" : "") + (pages && file.size >= BIG_MB * MB ? ", " : "") + (file.size >= BIG_MB * MB ? fmtSize(file.size) : "");
    const huge = pages >= HUGE_PAGES || file.size >= HUGE_MB * MB;
    return "Large PDF (" + what + "). This may take a few minutes." +
      (huge ? " Low-memory phones may fail; try splitting it." : "") +
      " Keep the app open.";
  }
  function batchNote(files) {
    const total = files.reduce((a, f) => a + f.size, 0);
    if (files.length < BATCH_FILES && total < BATCH_MB * MB) return "";
    return files.length + " PDFs (" + fmtSize(total) + ") run one by one. Keep the app open.";
  }

  function setBusy(busy, status, title, note) {
    state.busy = busy;
    if (!busy) state.batch = null;
    [el.btnAnalyze, el.btnClean, el.btnBatch, el.btnUnlock, $("#o-analyze"), $("#bubble"), $("#b-clean"), $("#b-add"), $("#b-pw")].forEach((b) => (b.disabled = busy));
    el.busyBar.hidden = !busy;
    if (busy) showOverlay(title, note); else hideOverlay();
    if (status) setStatus(status);
    if (busy) requestWake(); else releaseWake();
  }

  let wake = null;
  async function requestWake() { try { wake = await navigator.wakeLock?.request("screen"); } catch (e) { wake = null; } }
  function releaseWake() { try { wake?.release(); } catch (e) { /* ignore */ } wake = null; }

  function writeReport(text, append = false) {
    const t = tidyPaths(text).replace(/\s+$/, "") + "\n";
    el.report.textContent = append ? el.report.textContent + t : t;
    if (append) el.report.scrollTop = el.report.scrollHeight;
    const an = $("#an-report"); if (an) an.textContent = el.report.textContent;
  }
  function showResults() {
    $("#card-results").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* ------------------------------------------------------------------ *
   * Worker RPC                                                         *
   * ------------------------------------------------------------------ */
  let worker = null, seq = 0;
  const pending = new Map();

  function startWorker() {
    worker = new Worker("worker.js");
    worker.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === "boot") { bootProgress(m.stage, m.pct); return; }
      if (m.type === "status") { if (state.busy) setStatus(m.text); return; }
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      m.ok ? p.resolve(m) : p.reject(new Error(m.error || "Something went wrong."));
    };
    worker.onerror = (e) => bootFail(e.message || "The PDF engine could not start.");
  }
  function rpc(cmd, data = {}, transfer = []) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, cmd, ...data }, transfer);
    });
  }

  /* ------------------------------------------------------------------ *
   * Boot                                                               *
   * ------------------------------------------------------------------ */
  function bootProgress(stage, pct) {
    el.bootStage.textContent = stage;
    el.bootBar.style.width = pct + "%";
  }
  function bootFail(msg) {
    el.bootStage.textContent = "Couldn't start the PDF engine";
    el.bootNote.textContent = msg + " Check your connection (the first launch needs to download the engine) and try again.";
    el.bootRetry.hidden = false;
  }
  async function boot() {
    el.bootRetry.hidden = true;
    startWorker();
    try {
      await rpc("init");
    } catch (err) { return bootFail(err.message); }
    state.ready = true;
    el.boot.hidden = true;
    el.app.hidden = false;
    go("home");
    setStatus("Ready");
    registerSW();
    if (NATIVE) { el.pillText.textContent = "On\u2011device \u00b7 offline"; takeIncoming(); }
  }

  /* Android: a PDF sent to the app ("Open with" / Share) arrives via the native bridge. */
  async function takeIncoming() {
    if (!NATIVE || !state.ready || state.busy) return;
    const name = NATIVE.takeIncomingName();
    if (!name) return;
    try {
      const r = await fetch("/_incoming/current.pdf", { cache: "no-store" });
      if (!r.ok) throw new Error("Could not read the shared file.");
      go("upload", "single");
      await selectFile(new File([await r.blob()], name, { type: "application/pdf" }));
    } catch (err) { toast(err.message, true); }
  }
  window.__onIncoming = takeIncoming;
  el.bootRetry.addEventListener("click", () => { worker?.terminate(); pending.clear(); bootProgress("Starting…", 0); boot(); });

  function registerSW() {
    if (NATIVE || !("serviceWorker" in navigator) || !/^https?:$/.test(location.protocol)) return;
    navigator.serviceWorker.register("sw.js").then(() => navigator.serviceWorker.ready).then((reg) => {
      reg.active?.postMessage({ type: "cache-vendor" });
    }).catch(() => {});
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (e.data?.type === "offline-ready") { el.pillText.textContent = "On‑device · offline ready"; }
    });
  }

  /* ------------------------------------------------------------------ *
   * Settings                                                           *
   * ------------------------------------------------------------------ */
  function readSettings() {
    return {
      top: el.top.value, bottom: el.bottom.value, regions: el.regions.value,
      header: el.header.value, footer: el.footer.value,
      watermark: el.watermark.value, imgWm: el.imgWm.checked, xrefs: el.xrefs.value,
      meta: el.meta.checked, annots: el.annots.checked, links: el.links.checked, extras: el.extras.checked, hidden: el.hidden.checked,
      autoUpdate: el.autoUpd.checked, lite: el.lite.checked,
      theme: look.theme, accent: look.accent, v: 3,
    };
  }
  function applySettings(s) {
    el.top.value = s.top; el.bottom.value = s.bottom; el.regions.value = s.regions;
    el.header.value = s.header; el.footer.value = s.footer;
    el.watermark.value = s.watermark; el.imgWm.checked = !!s.imgWm; el.xrefs.value = s.xrefs;
    el.meta.checked = !!s.meta; el.annots.checked = !!s.annots; el.links.checked = !!s.links; el.extras.checked = !!s.extras; el.hidden.checked = !!s.hidden; el.autoUpd.checked = !!s.autoUpdate; el.lite.checked = !!s.lite; applyLite();
    look.theme = THEMES.some((t) => t.id === s.theme) ? s.theme : "eraser";
    look.accent = Number.isInteger(s.accent) ? s.accent : 0;
    applyAppearance();
    syncRange(el.top, el.topRange); syncRange(el.bottom, el.bottomRange);
    renderOverlay(); renderXrefChips();
  }
  let persistT = 0;
  function flushPersist() { clearTimeout(persistT); persistT = 0; if (state.itemMode) return; try { localStorage.setItem(STORE_KEY, JSON.stringify(readSettings())); } catch (e) { /* private mode */ } }
  function persist() { if (state.itemMode) return; clearTimeout(persistT); persistT = setTimeout(flushPersist, 250); }
  window.addEventListener("pagehide", flushPersist);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushPersist(); });
  function applyLite() { document.documentElement.classList.toggle("lite", el.lite.checked); }
  el.lite.addEventListener("change", applyLite);
  function loadSettings() {
    let s = DEFAULTS;
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
      if ((saved.v || 1) < 2 && saved.bottom === "2") saved.bottom = "0";
      if ((saved.v || 1) < 3 && saved.theme === "system") saved.theme = "eraser";
      s = { ...DEFAULTS, ...saved, v: 3 };
    } catch (e) { /* ignore */ }
    applySettings(s);
  }

  function syncRange(textEl, rangeEl) {
    const v = parseFloat(textEl.value);
    const max = +rangeEl.max;
    const val = isFinite(v) ? Math.min(Math.max(v, 0), max) : 0;
    rangeEl.value = val;
    rangeEl.style.setProperty("--fill", (val / max) * 100 + "%");
  }
  [[el.top, el.topRange], [el.bottom, el.bottomRange]].forEach(([t, r]) => {
    r.addEventListener("input", () => { t.value = String(r.value); syncRange(t, r); renderOverlay(); persist(); });
    t.addEventListener("input", () => { syncRange(t, r); renderOverlay(); persist(); });
  });
  [el.regions, el.header, el.footer, el.watermark, el.xrefs, el.imgWm, el.meta, el.annots, el.links, el.extras, el.hidden, el.autoUpd, el.lite].forEach((n) =>
    n.addEventListener("input", () => { persist(); if (n === el.regions) renderOverlay(); if (n === el.xrefs) renderXrefChips(); })
  );
  el.reset.addEventListener("click", () => { applySettings(DEFAULTS); persist(); toast("Settings reset to defaults"); });

  /* Same validation messages as the desktop tool. */
  function getOptions() {
    const top = parseFloat((el.top.value.trim() || "0").replace(",", "."));
    const bottom = parseFloat((el.bottom.value.trim() || "0").replace(",", "."));
    if (!isFinite(top) || !isFinite(bottom)) throw new Error("Top/header and bottom/footer values must be numbers (percentages).");
    if (!(top >= 0 && top < 100) || !(bottom >= 0 && bottom < 100)) throw new Error("Top/header and bottom/footer values must be from 0 to less than 100.");
    if (top + bottom >= 100) throw new Error("Top/header and bottom/footer bands together must cover less than 100% of a page.");
    return {
      remove_metadata: el.meta.checked, top, bottom,
      watermark: el.watermark.value, header: el.header.value, footer: el.footer.value,
      regions: el.regions.value, remove_image_watermarks: el.imgWm.checked, xrefs: el.xrefs.value,
      remove_annotations: el.annots.checked, remove_links: el.links.checked, remove_extras: el.extras.checked,
      remove_hidden_text: el.hidden.checked,
    };
  }

  /* ------------------------------------------------------------------ *
   * Password field                                                     *
   * ------------------------------------------------------------------ */

  /* ------------------------------------------------------------------ *
   * Choosing a file                                                    *
   * ------------------------------------------------------------------ */
  el.fileInput.addEventListener("change", () => { const f = el.fileInput.files[0]; el.fileInput.value = ""; if (f) { go("upload", "single"); selectFile(f); } });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => { e.preventDefault(); const f = e.dataTransfer?.files?.[0]; if (f && !state.busy) { go("upload", "single"); selectFile(f); } });

  const isPdf = (f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf";

  async function selectFile(file) {
    if (state.busy) return;
    if (!isPdf(file)) { toast("The input file must be a PDF.", true); return; }
    state.pages = 0; setTool(null);
    if (tooBig(file, 0)) { await confirmBox({ title: "PDF is too large", text: limitText(), ok: "OK", cancel: null }); if (!state.file) go("home"); return; }
    setBusy(true, "Opening " + file.name + "…", "Opening PDF", isBigFile(file, 0) ? bigFileNote(file, 0) : "");
    try {
      if (state.inPath) await rpc("rm", { paths: [state.inPath] });
      if (state.cleanPath) await rpc("rm", { paths: [state.cleanPath] });
      state.cleanPath = null; state.cleanName = null;
      clearOutputs();
      const key = file.name + "|" + file.size + "|" + file.lastModified;
      const cached = await ucGet(key);
      const buf = cached || (await file.arrayBuffer());
      const path = "/in/main/" + safeName(file.name);
      await rpc("put", { path, buffer: buf }, [buf]);
      state.file = file; state.inPath = path; state.page = 0; state.previewSrc = "orig";
      state.unlocked = !!cached; state.ucKey = cached ? key : null;
      const prot = cached ? { protected: false } : await rpc("protected", { path });
      state.locked = prot.protected || !!cached;
      if (prot.protected) {
        setBusy(false, "Password needed");
        const pw = await askPassword(file.name, (p) => rpc("preview", { path, password: p, page: 0, zoom: 0.2 }));
        if (pw === null) {
          try { await rpc("rm", { paths: [path] }); } catch (e) { /* ignore */ }
          state.file = null; state.inPath = null; state.pw = "";
          syncUploadItem(); go("home"); setBusy(false, "Ready"); return;
        }
        state.pw = pw;
        setBusy(true, "Opening " + file.name + "…", "Opening PDF");
        await saveUnlockedCopy(file, key, path, pw);
      } else { state.pw = ""; }
      el.prevCard.hidden = false; $("#vt-name").textContent = file.name; syncViewer();
      setSeg("orig"); el.seg.querySelector('[data-src="clean"]').disabled = true;
      writeReport("Tap Analyze to scan this PDF.");
      await loadPreview();
      if (tooBig(null, state.pages)) {
        try { await rpc("rm", { paths: [state.inPath] }); } catch (e) { /* ignore */ }
        Object.assign(state, { file: null, inPath: null, pages: 0 }); el.prevImg.hidden = true; syncViewer(); syncUploadItem(); setBusy(false, "Ready"); go("home");
        await confirmBox({ title: "PDF is too large", text: limitText(), ok: "OK", cancel: null }); return;
      }
      syncUploadItem();
      setBusy(false, "Input selected");
    } catch (err) {
      setBusy(false, "Could not open the PDF");
      toast(err.message, true);
    }
  }

  /* ------------------------------------------------------------------ *
   * Preview + overlay                                                  *
   * ------------------------------------------------------------------ */
  function setSeg(src) {
    state.previewSrc = src;
    $$("button", el.seg).forEach((b) => b.setAttribute("aria-selected", String(b.dataset.src === src)));
    el.stage.classList.toggle("is-clean", src === "clean");
    if (src === "clean") setTool(null);
    el.draw.disabled = src === "clean";
    renderOverlay();
  }
  el.seg.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || b.disabled || b.dataset.src === state.previewSrc) return;
    state.page = 0; setSeg(b.dataset.src); loadPreview();
  });
  el.pgPrev.addEventListener("click", () => { if (state.page > 0) { state.page--; loadPreview(); } });
  el.pgNext.addEventListener("click", () => { if (state.page < state.pages - 1) { state.page++; loadPreview(); } });

  /* Copyable text laid over the preview image: every word sits at its own position */
  let textLines = [], layoutGen = 0, layoutRaf = 0, measureCtx = null;
  const eoc = document.createElement("div"); eoc.className = "eoc";
  function resetTextDom() { const tl = $("#textlayer"); tl.textContent = ""; tl.append(eoc); return tl; }
  function clearTextLayer() { layoutGen++; textLines = []; resetTextDom(); }
  document.addEventListener("selectionchange", () => {
    const sel = document.getSelection(), tl = $("#textlayer");
    const on = !!sel && sel.rangeCount > 0 && !sel.isCollapsed && tl.contains(sel.anchorNode);
    zoomG.selecting = on; tl.classList.toggle("sel", on);
  });
  function naturalWidth(w) {
    if (w.nw) return w.nw;
    measureCtx = measureCtx || document.createElement("canvas").getContext("2d");
    measureCtx.font = "100px sans-serif";
    w.nw = (measureCtx.measureText(w[4]).width || 1) / 100;
    return w.nw;
  }
  function buildTextLine(line, W, H) {
    const [x0, y0, x1, y1, words] = line;
    const lw = (x1 - x0) * W, lh = (y1 - y0) * H;
    if (lw < 2 || lh < 2) return null;
    const vertical = lh > lw * 1.5 && words.reduce((n, w) => n + w[4].length, 0) > 2;
    const div = document.createElement("div"); div.className = "tl";
    const fs = (vertical ? lw : lh) * 0.85;
    Object.assign(div.style, { left: x0 * W + "px", top: y0 * H + "px", lineHeight: (vertical ? lw : lh) + "px" });
    if (vertical) { div.style.width = lw + "px"; div.style.writingMode = "vertical-rl"; } else div.style.height = lh + "px";
    let cursor = vertical ? y0 : x0;
    words.forEach((w, j) => {
      const a0 = vertical ? w[1] : w[0], a1 = vertical ? w[3] : w[2];
      const len = (a1 - a0) * (vertical ? H : W);
      if (len < 1) return;
      const k = Math.min(8, Math.max(0.1, len / (naturalWidth(w) * fs)));
      const sp = document.createElement("span"); sp.textContent = w[4];
      sp.style.fontSize = fs + "px";
      if (vertical) { sp.style.height = len + "px"; sp.style.width = lw + "px"; sp.style.marginTop = (a0 - cursor) * H + "px"; sp.style.transform = "scaleY(" + k + ")"; }
      else { sp.style.width = len + "px"; sp.style.marginLeft = (a0 - cursor) * W + "px"; sp.style.transform = "scaleX(" + k + ")"; }
      cursor = a1; div.append(sp);
      if (j < words.length - 1) div.append(" ");
    });
    return div;
  }
  function layoutTextLayer() {
    const gen = ++layoutGen, tl = resetTextDom();
    const W = $("#pagebox").clientWidth, H = $("#pagebox").clientHeight;
    if (!W || !H || !textLines.length) return;
    let i = 0;
    const step = () => {
      if (gen !== layoutGen) return;
      const frag = document.createDocumentFragment(), end = Math.min(i + 40, textLines.length);
      for (; i < end; i++) { const d = buildTextLine(textLines[i], W, H); if (d) frag.append(d); }
      tl.insertBefore(frag, eoc);
      if (i < textLines.length) requestAnimationFrame(step);
    };
    step();
  }
  function scheduleLayout() { if (!layoutRaf) layoutRaf = requestAnimationFrame(() => { layoutRaf = 0; layoutTextLayer(); }); }
  async function loadTextLayer(path, pw, page, token) {
    try {
      const r = await rpc("words", { path, password: pw, page });
      if (token !== state.previewToken) return;
      textLines = JSON.parse(r.json).lines; layoutTextLayer();
    } catch (e) { if (token === state.previewToken) clearTextLayer(); }
  }
  if (window.ResizeObserver) new ResizeObserver(scheduleLayout).observe($("#pagebox"));
  el.prevImg.addEventListener("load", scheduleLayout);

  /* Preview rendering: quick page flips are merged into one render; size follows the screen */
  let previewRun = null, previewAgain = false;
  function previewZoom() {
    if (!state.pageW) return 1.5;
    const target = Math.min(Math.max(innerWidth, innerHeight) * Math.min(window.devicePixelRatio || 1, 2), 2000) * (SC < 1 ? 0.8 : 1);
    return Math.min(2.5, Math.max(0.8, target / Math.max(state.pageW, state.pageH)));
  }
  function loadPreview() {
    if (previewRun) { previewAgain = true; return previewRun; }
    previewRun = (async () => { do { previewAgain = false; await loadPreviewOnce(); } while (previewAgain); })().finally(() => { previewRun = null; });
    return previewRun;
  }
  async function loadPreviewOnce() {
    const token = ++state.previewToken;
    clearTextLayer();
    const path = state.previewSrc === "clean" ? state.cleanPath : state.inPath;
    if (!path) return;
    const needsPw = state.previewSrc === "orig" && state.locked && !state.unlocked && !state.pw;
    if (needsPw) {
      el.prevImg.hidden = true;
      el.stageMsg.textContent = "This PDF is password-protected. Enter the password to see a preview.";
      el.pgLabel.textContent = "Locked"; el.pgPrev.disabled = el.pgNext.disabled = true; el.draw.disabled = true;
      return;
    }
    el.stageMsg.textContent = "Rendering…";
    try {
      const pw = state.previewSrc === "orig" ? state.pw : "";
      const r = await rpc("preview", { path, password: pw, page: state.page, zoom: previewZoom() });
      if (token !== state.previewToken || previewAgain) return;
      const url = URL.createObjectURL(new Blob([r.png], { type: "image/jpeg" }));
      const old = state.previewUrl; state.previewUrl = url;
      el.prevImg.src = url; el.prevImg.hidden = false;
      if (old) setTimeout(() => URL.revokeObjectURL(old), 2000);
      el.stageMsg.textContent = "";
      state.pages = r.pages; state.page = r.page; state.pageW = r.w; state.pageH = r.h;
      el.pgLabel.textContent = "Page " + (r.page + 1) + " of " + r.pages;
      el.pgPrev.disabled = r.page <= 0; el.pgNext.disabled = r.page >= r.pages - 1;
      el.draw.disabled = state.previewSrc === "clean";
      renderOverlay();
      if (state.shownPage !== r.page) { zoomG.reset(); state.shownPage = r.page; }
      zoomG.refresh();
      loadTextLayer(path, pw, r.page, token);
    } catch (err) {
      if (token !== state.previewToken) return;
      el.prevImg.hidden = true;
      el.stageMsg.textContent = err.message;
      el.pgLabel.textContent = "—"; el.pgPrev.disabled = el.pgNext.disabled = true;
    }
  }

  function parseRegionsLenient(raw) {
    const out = [];
    raw.split(";").forEach((part) => {
      const v = part.split(",").map((x) => parseFloat(x.trim()));
      if (v.length === 4 && v.every((n) => isFinite(n) && n >= 0 && n <= 100) && v[0] < v[2] && v[1] < v[3]) out.push(v);
    });
    return out;
  }
  function removeRegion(i) {
    const list = parseRegionsLenient(el.regions.value);
    list.splice(i, 1);
    el.regions.value = list.map((v) => v.join(",")).join("; ");
    persist(); renderOverlay();
  }
  function renderOverlay() {
    const o = el.overlay; o.textContent = "";
    if (state.previewSrc === "clean") return;
    const top = parseFloat((el.top.value || "0").replace(",", ".")) || 0;
    const bottom = parseFloat((el.bottom.value || "0").replace(",", ".")) || 0;
    const mk = (cls, css, label) => {
      const d = document.createElement("div"); d.className = cls; Object.assign(d.style, css);
      if (label) { const t = document.createElement("span"); t.className = "tag"; t.textContent = label; d.appendChild(t); }
      o.appendChild(d); return d;
    };
    if (top > 0 && top < 100) mk("b t", { height: top + "%" }, "Header " + top + "%");
    if (bottom > 0 && bottom < 100) mk("b f", { height: bottom + "%" }, "Footer " + bottom + "%");
    parseRegionsLenient(el.regions.value).forEach(([x0, y0, x1, y1], i) => {
      const box = mk("r", { left: x0 + "%", top: y0 + "%", width: x1 - x0 + "%", height: y1 - y0 + "%" }, String(i + 1));
      const x = document.createElement("button");
      x.type = "button"; x.className = "rx"; x.setAttribute("aria-label", "Delete area " + (i + 1));
      x.innerHTML = '<svg class="ic"><use href="#i-x"/></svg>';
      x.addEventListener("pointerdown", (e) => e.stopPropagation());
      x.addEventListener("click", (e) => { e.stopPropagation(); removeRegion(i); });
      box.appendChild(x);
    });
    positionHandles();
  }

  /* Draw custom areas directly on the preview */
  /* Tools on the preview: header/footer pull bars and Draw area */
  function positionHandles() {
    const n = (v) => parseFloat(String(v || "0").replace(",", ".")) || 0;
    $("#hf-t").style.top = Math.min(n(el.top.value), 90) + "%";
    $("#hf-f").style.bottom = Math.min(n(el.bottom.value), 90) + "%";
  }
  function setTool(t) {
    state.drawing = t === "draw"; state.hf = t === "hf";
    el.stage.classList.toggle("drawing", state.drawing);
    el.stage.classList.toggle("hfmode", state.hf);
    $("#hf").hidden = !state.hf;
    $("#bubble").classList.toggle("active", !!t);
    if (state.hf) positionHandles();
  }
  const toggleDraw = (on) => setTool(on ? "draw" : null);
  ["t", "f"].forEach((w) => {
    const node = $("#hf-" + w);
    let on = false, off = 0, raf = 0, pending = null;
    node.addEventListener("pointerdown", (e) => {
      on = true; node.setPointerCapture(e.pointerId); e.preventDefault();
      const r = node.getBoundingClientRect();
      off = w === "t" ? e.clientY - r.top : e.clientY - r.bottom;
    });
    node.addEventListener("pointermove", (e) => {
      if (!on) return;
      const r = el.prevImg.getBoundingClientRect();
      const y = e.clientY - off;
      const raw = w === "t" ? ((y - r.top) / r.height) * 100 : ((r.bottom - y) / r.height) * 100;
      const pct = Math.round(Math.min(40, Math.max(0, raw)) * 2) / 2;
      const t = w === "t" ? el.top : el.bottom;
      pending = { t, pct };
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; const q = pending; if (q && q.t.value !== String(q.pct)) { q.t.value = String(q.pct); q.t.dispatchEvent(new Event("input")); } });
    });
    const end = () => { on = false; };
    node.addEventListener("pointerup", end);
    node.addEventListener("pointercancel", end);
  });
  (() => {
    let start = null, live = null;
    const pt = (e) => {
      const r = el.prevImg.getBoundingClientRect();
      return [Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100)), Math.min(100, Math.max(0, ((e.clientY - r.top) / r.height) * 100))];
    };
    el.stage.addEventListener("pointerdown", (e) => {
      if (!state.drawing || el.prevImg.hidden) return;
      e.preventDefault(); el.stage.setPointerCapture(e.pointerId);
      start = pt(e);
      live = document.createElement("div"); live.className = "r live"; el.overlay.appendChild(live);
    });
    el.stage.addEventListener("pointermove", (e) => {
      if (!start || !live) return;
      const [x, y] = pt(e);
      Object.assign(live.style, { left: Math.min(start[0], x) + "%", top: Math.min(start[1], y) + "%", width: Math.abs(x - start[0]) + "%", height: Math.abs(y - start[1]) + "%" });
    });
    const end = (e) => {
      if (!start) return;
      const [x, y] = pt(e);
      const [x0, x1] = [Math.min(start[0], x), Math.max(start[0], x)];
      const [y0, y1] = [Math.min(start[1], y), Math.max(start[1], y)];
      start = null; live = null;
      if (x1 - x0 >= 1.5 && y1 - y0 >= 1) {
        const r1 = (n) => (Math.round(n * 10) / 10).toString();
        const rect = [x0, y0, x1, y1].map(r1).join(",");
        const cur = el.regions.value.trim().replace(/;\s*$/, "");
        el.regions.value = cur ? cur + "; " + rect : rect;
        persist();
      }
      renderOverlay();
    };
    el.stage.addEventListener("pointerup", end);
    el.stage.addEventListener("pointercancel", () => { start = null; live = null; renderOverlay(); });
    el.stage.addEventListener("pinchstart", () => { if (live) live.remove(); start = null; live = null; });
  })();

  /* ------------------------------------------------------------------ *
   * XRef chips (from Analyze)                                          *
   * ------------------------------------------------------------------ */
  let lastXrefs = []; // [{id, likely}]
  function parseXrefs(report) {
    const out = [];
    report.split("\n").forEach((l) => {
      const m = l.match(/^\s*XRef (\d+):/);
      if (m) out.push({ id: m[1], likely: /\[likely transparent watermark\]/.test(l) });
    });
    return out;
  }
  function currentXrefSet() { return new Set(el.xrefs.value.split(/[;,\n]+/).map((s) => s.trim()).filter(Boolean)); }
  function renderXrefChips() {
    const c = el.chips; c.textContent = "";
    if (!lastXrefs.length) { c.hidden = true; return; }
    c.hidden = false;
    const lbl = document.createElement("div"); lbl.className = "lbl";
    lbl.textContent = "Image XRefs found. Tap to add or remove from the list to delete:";
    c.appendChild(lbl);
    const on = currentXrefSet();
    lastXrefs.forEach(({ id, likely }) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "chip" + (on.has(id) ? " on" : "");
      b.textContent = "XRef " + id + (likely ? " · likely watermark" : "");
      b.addEventListener("click", () => {
        const set = currentXrefSet();
        set.has(id) ? set.delete(id) : set.add(id);
        el.xrefs.value = [...set].join("; ");
        persist(); renderXrefChips();
      });
      c.appendChild(b);
    });
  }

  /* ------------------------------------------------------------------ *
   * Outputs: save / share                                              *
   * ------------------------------------------------------------------ */
  function clearOutputs() { state.outputs = []; el.outputs.textContent = ""; el.outputs.hidden = true; }

  function svgIcon(id) {
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); s.setAttribute("class", "ic");
    const u = document.createElementNS("http://www.w3.org/2000/svg", "use"); u.setAttribute("href", "#" + id); s.appendChild(u); return s;
  }
  function btn(label, icon, cls, fn) {
    const b = document.createElement("button"); b.type = "button"; b.className = "btn " + cls;
    b.appendChild(svgIcon(icon)); const sp = document.createElement("span"); sp.textContent = label; b.appendChild(sp);
    b.setAttribute("aria-label", label); b.addEventListener("click", fn); return b;
  }
  // Android app: stream the file to native code in chunks, which then opens
  // "Save to…" (system file picker) or the share sheet.
  async function nativeSend(blob, name, mode) {
    NATIVE.begin(name, blob.type || "application/octet-stream");
    const CH = 3 * 256 * 1024; // multiple of 3 keeps each base64 chunk self-contained
    for (let o = 0; o < blob.size; o += CH) {
      const u8 = new Uint8Array(await blob.slice(o, o + CH).arrayBuffer());
      let bin = "";
      for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
      NATIVE.chunk(btoa(bin));
    }
    NATIVE.finish(mode);
  }
  function download(blob, name) {
    if (NATIVE) { nativeSend(blob, name, "save").catch((e) => toast("Couldn't save: " + e.message, true)); return; }
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  async function share(blob, name, type) {
    if (NATIVE) { try { await nativeSend(blob, name, "share"); } catch (e) { toast("Couldn't share: " + e.message, true); } return; }
    const file = new File([blob], name, { type });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); return; }
      catch (e) { if (e.name === "AbortError") return; }
    }
    download(blob, name);
  }
  function addOutput({ name, blob, type = "application/pdf", previewable = false, error = null }) {
    const row = document.createElement("div"); row.className = "out" + (error ? " err" : "");
    const ic = document.createElement("span"); ic.className = "fic"; ic.appendChild(svgIcon(error ? "i-alert" : type === "application/zip" ? "i-layers" : "i-file"));
    const meta = document.createElement("span"); meta.className = "fmeta";
    const b = document.createElement("b"); b.textContent = name;
    const s = document.createElement("small"); s.textContent = error ? error : fmtSize(blob.size);
    meta.append(b, s); row.append(ic, meta);
    if (!error) {
      const acts = document.createElement("span"); acts.className = "acts";
      if (previewable) acts.appendChild(btn("View", "i-eye", "ghost", () => { state.page = 0; setSeg("clean"); loadPreview(); $("#card-preview").scrollIntoView({ behavior: "smooth", block: "center" }); }));
      if (NATIVE || navigator.canShare?.({ files: [new File([], "a.pdf", { type: "application/pdf" })] }))
        acts.appendChild(btn("Share", "i-share", "ghost", () => share(blob, name, type)));
      acts.appendChild(btn("Save", "i-download", "primary", () => download(blob, name)));
      row.appendChild(acts);
    }
    el.outputs.appendChild(row); el.outputs.hidden = false;
    state.outputs.push({ name, blob });
  }

  /* Minimal ZIP (stored) writer for batch results */
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (u8) => { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  async function makeZip(files) {
    const enc = new TextEncoder(), parts = [], central = [];
    let offset = 0;
    const d = new Date();
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    for (const f of files) {
      const name = enc.encode(f.name), data = new Uint8Array(await f.blob.arrayBuffer()), crc = crc32(data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
      lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      parts.push(lh.buffer, name, data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
      ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true);
      ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
      ch.setUint32(42, offset, true);
      central.push(ch.buffer, name);
      offset += 30 + name.length + data.length;
    }
    const csize = central.reduce((a, b) => a + (b.byteLength ?? b.length), 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, csize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end.buffer], { type: "application/zip" });
  }

  /* ------------------------------------------------------------------ *
   * Actions                                                            *
   * ------------------------------------------------------------------ */
  function requireInput() {
    if (!state.file) throw new Error("Choose an input PDF first.");
    return state.inPath;
  }
  function fail(title, err) {
    if (err && err.cancelled) return;
    const msg = err.message || String(err);
    setBusy(false, title);
    writeReport(title + ": " + msg);
    toast(msg, true);
  }

  el.btnAnalyze.addEventListener("click", async () => {
    if (state.busy) return;
    let input;
    try { input = requireInput(); } catch (e) { toast(e.message, true); return; }
    setBusy(true, "Analyzing PDF…", "Analyzing PDF", bigFileNote(state.file, state.pages)); startEta(getSpp() * 0.5 * state.pages); writeReport("Analysis running…");
    try {
      const r = await rpc("job", { job: { kind: "analyze", input, password: state.pw, watermark: el.watermark.value, header: el.header.value, footer: el.footer.value } });
      writeReport(r.report);
      lastXrefs = parseXrefs(r.report); renderXrefChips(); renderAnalysis(r.report);
      setBusy(false, "Analysis complete"); openModal("modal-analysis");
    } catch (err) { if (err.cancelled) { await afterCancel(false); return; } fail("Analysis failed", err); }
  });

  /* ------------------------------------------------------------------ *
   * Clean / unlock: name box -> choose folder -> run -> save           *
   * ------------------------------------------------------------------ */
  const SUFFIX = { clean: "_clean", unlock: "_unlocked", batch: "_clean" };
  const nameCtx = { kind: "clean" };
  const previewName = () => safeName(stemOf((nameCtx.kind === "batch" ? (batch.items[0] || {}).name : state.file.name) || "file") + ($("#nm-suffix").value.trim() || SUFFIX[nameCtx.kind]) + ".pdf");

  function pickFolder() {
    if (!NATIVE || typeof NATIVE.pickFolder !== "function") return Promise.resolve("Downloads");
    return new Promise((resolve) => {
      window.__onFolderPicked = (json) => { let r = {}; try { r = JSON.parse(json); } catch (e) { /* ignore */ } resolve(r.ok ? r.name || "folder" : null); };
      NATIVE.pickFolder();
    });
  }
  async function saveBlob(blob, name, quiet) {
    if (NATIVE && typeof NATIVE.pickFolder === "function") await nativeSend(blob, name, quiet ? "folder_quiet" : "folder");
    else download(blob, name);
  }
  function openNameDialog(kind) {
    if (state.busy) return;
    try { if (kind !== "batch") requireInput(); if (kind !== "unlock") getOptions(); } catch (e) { toast(e.message, true); return; }
    nameCtx.kind = kind;
    $("#nm-suffix").value = SUFFIX[kind];
    $("#nm-preview").textContent = previewName();
    $("#mn-title").textContent = kind === "unlock" ? "Name the unlocked copy" : kind === "batch" ? "Name your cleaned copies" : "Name your cleaned copy";
    openModal("modal-name");
  }
  $("#nm-suffix").addEventListener("input", () => { $("#nm-preview").textContent = previewName(); });
  $("#nm-save").addEventListener("click", async () => {
    const name = previewName(), kind = nameCtx.kind;
    closeModal($("#modal-name"));
    const folder = await pickFolder();
    if (!folder) { toast("Choose a folder to save."); openModal("modal-name"); return; }
    if (kind === "batch") await runBatch($("#nm-suffix").value.trim() || SUFFIX.batch, folder);
    else await runSave(kind, name, folder);
  });

  async function runSave(kind, name, folder) {
    const input = state.inPath, password = state.pw;
    const unlock = kind === "unlock";
    let opts = null;
    try { if (!unlock) opts = getOptions(); } catch (e) { toast(e.message, true); return; }
    const title = unlock ? "Unlocking PDF" : "Cleaning PDF";
    if (!unlock && isHuge(state.file, state.pages) && !(await confirmBox({ title: "Large PDF", text: bigFileNote(state.file, state.pages) + " Continue?", ok: "Continue" }))) return;
    const t0 = Date.now();
    setBusy(true, title + "…", title, bigFileNote(state.file, state.pages));
    startEta(unlock ? 0 : getSpp() * state.pages);
    writeReport(title + " started. The original is not changed.");
    clearOutputs();
    const output = (unlock ? "/out/unlock/" : "/out/main/") + name;
    try {
      if (!unlock && state.cleanPath) { await rpc("rm", { paths: [state.cleanPath] }); state.cleanPath = null; }
      const job = unlock ? { kind: "unlock", input, output, password } : { kind: "clean", input, output, password, options: opts };
      const r = await rpc("job", { job });
      $("#busy-cancel").hidden = true;
      writeReport(r.report);
      const got = await rpc("get", { path: output });
      const blob = new Blob([got.buffer], { type: "application/pdf" });
      if (unlock) await rpc("rm", { paths: [output] });
      else {
        state.cleanPath = output; state.cleanName = name;
        el.seg.querySelector('[data-src="clean"]').disabled = false;
        state.page = 0; setSeg("clean"); loadPreview();
      }
      if (!unlock) learnSpeed(state.pages, (Date.now() - t0) / 1000);
      await saveBlob(blob, name);
      setBusy(false, "Done");
      if (!NATIVE) toast("Saved " + name);
      else toast("Saving to " + folder + "…");
    } catch (err) { if (err.cancelled) { await afterCancel(false); return; } fail(title + " failed", err); }
  }

  /* ------------------------------------------------------------------ *
   * Password prompt                                                    *
   * ------------------------------------------------------------------ */
  function askPassword(name, verify) {
    return new Promise((resolve) => {
      const m = $("#modal-password"), inp = $("#mp-input"), err = $("#mp-err"), ok = $("#mp-ok");
      $("#mp-file").textContent = name; inp.value = ""; err.textContent = ""; inp.type = "password";
      let done = false;
      const finish = (v) => { if (done) return; done = true; m.removeEventListener("modalclose", onClose); resolve(v); };
      const onClose = () => finish(null);
      m.addEventListener("modalclose", onClose);
      const submit = async () => {
        if (!inp.value) { err.textContent = "Enter the password."; return; }
        ok.disabled = true; err.textContent = "";
        try { await verify(inp.value); finish(inp.value); closeModal(m); }
        catch (e) { err.textContent = /password/i.test(e.message || "") ? "Wrong password. Try again." : (e.message || "Couldn't open the PDF."); inp.select(); }
        finally { ok.disabled = false; }
      };
      ok.onclick = submit;
      $("#mp-cancel").onclick = () => closeModal(m);
      inp.onkeydown = (e) => { if (e.key === "Enter") submit(); };
      $("#mp-toggle").onclick = () => { inp.type = inp.type === "password" ? "text" : "password"; };
      openModal("modal-password");
      setTimeout(() => inp.focus(), 60);
    });
  }

  el.copy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(el.report.textContent); toast("Report copied"); }
    catch (e) { toast("Couldn't copy. Press and hold the text to select it.", true); }
  });


  /* ------------------------------------------------------------------ *
   * App updates (Android app only). The network request is made by the *
   * native layer; this page never touches the internet.                *
   * ------------------------------------------------------------------ */
  const UPD_TS_KEY = "pdfcleaner.lastUpdateCheck";
  const upd = { checking: false, silent: false, timer: 0, info: null };

  function updSetChecking(on) {
    upd.checking = on;
    el.updCheck.disabled = on;
    el.updCheckLabel.textContent = on ? "Checking…" : "Check for updates";
  }
  function updShowAvailable(info) {
    upd.info = info;
    const label = "Update to " + info.latest;
    el.updCard.classList.add("has-update");
    el.updStatus.textContent = "Version " + info.latest + " is available. You have " + info.current + ".";
    el.updGet.hidden = false; el.updGetLabel.textContent = info.apk ? "Download " + info.latest : label;
    el.updNotes.hidden = !info.notes; el.updNotes.textContent = info.notes || "";
    el.updTop.hidden = false; el.updTopTitle.textContent = "Update available: " + info.latest;
  }
  function updClearAvailable() {
    upd.info = null;
    el.updCard.classList.remove("has-update");
    el.updGet.hidden = true; el.updNotes.hidden = true; el.updTop.hidden = true;
  }
  window.__onUpdateResult = (json) => {
    clearTimeout(upd.timer);
    const silent = upd.silent;
    updSetChecking(false);
    let r;
    try { r = JSON.parse(json); } catch (e) { r = { status: "error", error: "Unexpected answer" }; }
    try { localStorage.setItem(UPD_TS_KEY, String(Date.now())); } catch (e) { /* ignore */ }
    if (r.status === "update") { updShowAvailable(r); if (!silent) toast("Update available: " + r.latest); return; }
    updClearAvailable();
    if (silent) return;
    if (r.status === "ok") el.updStatus.textContent = "You're up to date (version " + r.current + ").";
    else if (r.status === "none") el.updStatus.textContent = "No releases yet. You have version " + r.current + ".";
    else if (r.status === "not_configured") el.updStatus.textContent = "Updates aren't set up.";
    else { el.updStatus.textContent = "Couldn't check: " + (r.error || "unknown error") + "."; toast("Update check failed", true); }
  };
  function checkForUpdates(silent) {
    if (!NATIVE || upd.checking || typeof NATIVE.checkUpdate !== "function") return;
    upd.silent = !!silent;
    updSetChecking(true);
    if (!silent) el.updStatus.textContent = "Contacting GitHub…";
    upd.timer = setTimeout(() => {
      if (!upd.checking) return;
      updSetChecking(false);
      if (!silent) el.updStatus.textContent = "Couldn't check: the request took too long.";
    }, 20000);
    try { NATIVE.checkUpdate(); } catch (e) { updSetChecking(false); if (!silent) el.updStatus.textContent = "Couldn't check: " + e.message; }
  }
  function initUpdates() {
    if (!NATIVE || typeof NATIVE.checkUpdate !== "function") return; // browser/PWA: no update UI
    el.updCard.hidden = false;
    try { el.appVer.textContent = "Version " + NATIVE.getVersion(); } catch (e) { /* ignore */ }
    el.updCheck.addEventListener("click", () => checkForUpdates(false));
    el.updGet.addEventListener("click", () => { if (upd.info) NATIVE.openUrl(upd.info.apk || upd.info.url); });
    el.updTop.addEventListener("click", () => el.updCard.scrollIntoView({ behavior: "smooth", block: "center" }));
    if (el.autoUpd.checked) {
      let last = 0;
      try { last = Number(localStorage.getItem(UPD_TS_KEY)) || 0; } catch (e) { /* ignore */ }
      if (Date.now() - last > 24 * 3600 * 1000) checkForUpdates(true);
    }
  }


  /* ------------------------------------------------------------------ *
   * Menu / views                                                       *
   * ------------------------------------------------------------------ */
  const VIEWS = { home: $("#view-home"), upload: $("#view-upload"), batch: $("#view-batch"), settings: $("#view-settings") };
  const TITLES = { settings: "Settings", single: "Upload a PDF", batch: "Batch Upload" };
  const nav = { view: "home", mode: "single", subTitle: $("#sub-title") };
  function go(view, mode) {
    nav.view = view;
    if (zoomG.reset) zoomG.reset();
    if (view !== "upload") setTool(null);
    if (view === "settings") refreshUc();
    if (mode) nav.mode = mode;
    Object.entries(VIEWS).forEach(([k, n]) => (n.hidden = k !== view));
    el.app.dataset.view = view;
    VIEWS.upload.dataset.mode = nav.mode;
    el.bar.dataset.mode = nav.mode;
    el.bar.hidden = view !== "upload" || nav.mode !== "batch" || !state.ready;
    el.btnBatch.classList.toggle("main", nav.mode === "batch");
    nav.subTitle.textContent = view === "settings" ? TITLES.settings : view === "batch" ? TITLES.batch : view === "upload" ? TITLES.single : "";
    if (view === "batch") renderBatch();
    placeBubble(view);
    syncViewer();
    window.scrollTo(0, 0);
  }
  function syncViewer() {
    const on = nav.view === "upload" && nav.mode === "single" && !!state.file;
    VIEWS.upload.dataset.file = on ? "1" : "0";
    document.body.classList.toggle("viewer-open", on);
  }
  $("#m-upload").addEventListener("click", () => { if (state.busy) return; if (state.file) go("upload", "single"); else el.fileInput.click(); });
  $("#m-replace").addEventListener("click", () => { if (!state.busy) el.fileInput.click(); });
  $("#m-delete").addEventListener("click", async () => {
    if (state.busy || !state.file) return;
    if (await confirmBox({ title: "Delete this PDF?", text: state.file.name, ok: "Delete" })) await clearFile();
  });
  function syncUploadItem() {
    const f = state.file;
    $("#m-upload-title").textContent = f ? f.name : "Upload a PDF";
    $("#m-upload-sub").textContent = f ? [fmtSize(f.size), state.pages ? state.pages + " pages" : "", state.locked ? "unlocked" : ""].filter(Boolean).join(" · ") : "Clean or unlock one file";
    $("#m-upload .mi use").setAttribute("href", f ? "#i-file" : "#i-upload");
    $("#m-upload-actions").hidden = !f;
  }
  async function clearFile() {
    const paths = [state.inPath, state.cleanPath].filter(Boolean);
    try { if (paths.length) await rpc("rm", { paths }); } catch (e) { /* ignore */ }
    if (state.ucKey) ucDel(state.ucKey);
    Object.assign(state, { file: null, inPath: null, cleanPath: null, cleanName: null, locked: false, pages: 0, pw: "", unlocked: false, ucKey: null });
    el.prevImg.hidden = true; el.prevCard.hidden = true; clearOutputs(); setTool(null); syncViewer(); syncUploadItem();
    toast("PDF deleted");
  }
  $("#m-batch").addEventListener("click", () => { if (state.busy) return; if (batch.items.length) go("batch"); else el.batchInput.click(); });
  $("#m-settings").addEventListener("click", () => go("settings"));
  $("#back-btn").addEventListener("click", () => go("home"));

  /* ------------------------------------------------------------------ *
   * Themes + partner accent colors                                     *
   * ------------------------------------------------------------------ */
  const THEMES = [
    { id: "system", name: "System", sw: "linear-gradient(115deg,#f4f5fa 50%,#0d0f17 50%)" },
    { id: "light", name: "Light", sw: "linear-gradient(#f4f5fa,#fff)" },
    { id: "dark", name: "Dark", sw: "linear-gradient(#0d0f17,#161924)" },
    { id: "midnight", name: "Midnight", sw: "linear-gradient(#000,#0b0b10)" },
    { id: "sepia", name: "Sepia", sw: "linear-gradient(#f3ead7,#fbf5e8)" },
    { id: "eraser", name: "Eraser", sw: "linear-gradient(115deg,#fbeee9 55%,#e0457b 55%)" },
    { id: "soap", name: "Soap", sw: "radial-gradient(circle at 32% 38%,#fff 0 16%,#bfeaf0 17% 22%,transparent 23%),linear-gradient(#eefaf8,#cdeae6)" },
  ];
  /* [name, accent (text/outline), gradient start, gradient end] */
  const ACCENTS = {
    light: [["Indigo", "#4f46e5", "#4f46e5", "#7c3aed"], ["Teal", "#0f766e", "#0f766e", "#0891b2"], ["Rose", "#be123c", "#be123c", "#e11d48"], ["Orange", "#c2410c", "#c2410c", "#ea580c"], ["Blue", "#1d4ed8", "#1d4ed8", "#0ea5e9"]],
    dark: [["Violet", "#a5a1ff", "#5b4ee6", "#7c3aed"], ["Mint", "#34d399", "#047857", "#059669"], ["Sky", "#38bdf8", "#0369a1", "#0284c7"], ["Pink", "#f472b6", "#be185d", "#db2777"], ["Amber", "#fbbf24", "#b45309", "#d97706"]],
    midnight: [["Cyan", "#22d3ee", "#0e7490", "#0891b2"], ["Lime", "#a3e635", "#4d7c0f", "#65a30d"], ["Magenta", "#e879f9", "#a21caf", "#c026d3"], ["Coral", "#fb7185", "#be123c", "#e11d48"], ["Gold", "#facc15", "#a16207", "#ca8a04"]],
    eraser: [["Rubber pink", "#c2185b", "#c2185b", "#e0457b"], ["Sleeve blue", "#1d4ed8", "#1d4ed8", "#3b82f6"], ["Graphite", "#374151", "#374151", "#6b7280"], ["Pencil yellow", "#b45309", "#b45309", "#e39a1d"], ["Brick red", "#b91c1c", "#b91c1c", "#ef4444"]],
    soap: [["Aqua", "#0e8f9b", "#0e8f9b", "#2bb3c0"], ["Lavender", "#6d4fd0", "#6d4fd0", "#8b6df0"], ["Mint", "#0b8a63", "#0b8a63", "#22b985"], ["Rose petal", "#c93a6e", "#c93a6e", "#e8609a"], ["Citrus", "#c2680a", "#c2680a", "#e39a1d"]],
    sepia: [["Terracotta", "#b45309", "#b45309", "#d97706"], ["Olive", "#4d7c0f", "#4d7c0f", "#65a30d"], ["Teal", "#0f766e", "#0f766e", "#0d9488"], ["Plum", "#86198f", "#86198f", "#a21caf"], ["Navy", "#1e40af", "#1e40af", "#2563eb"]],
  };
  const look = { theme: "eraser", accent: 0 };
  const darkMQ = window.matchMedia("(prefers-color-scheme: dark)");
  const effectiveTheme = () => (look.theme === "system" ? (darkMQ.matches ? "dark" : "light") : look.theme);
  function applyAppearance() {
    const t = effectiveTheme(), root = document.documentElement;
    root.dataset.theme = t;
    const list = ACCENTS[t];
    const a = list[Math.min(look.accent, list.length - 1)];
    root.style.setProperty("--accent", a[1]);
    root.style.setProperty("--grad-a", a[2]);
    root.style.setProperty("--grad-b", a[3]);
    root.style.setProperty("--accent-2", a[3]);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = getComputedStyle(root).getPropertyValue("--bg").trim() || meta.content;
    renderAppearance(list);
  }
  function renderAppearance(list) {
    const tl = $("#theme-list"), al = $("#accent-list");
    tl.textContent = ""; al.textContent = "";
    THEMES.forEach((t) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "theme-chip"; b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(look.theme === t.id));
      const sw = document.createElement("span"); sw.className = "sw"; sw.style.background = t.sw;
      const nm = document.createElement("span"); nm.textContent = t.name;
      b.append(sw, nm);
      b.addEventListener("click", () => { look.theme = t.id; look.accent = 0; applyAppearance(); persist(); });
      tl.append(b);
    });
    list.forEach((a, i) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "accent-dot"; b.setAttribute("role", "radio"); b.setAttribute("aria-label", a[0]);
      b.setAttribute("aria-checked", String(look.accent === i));
      b.style.background = "linear-gradient(135deg," + a[2] + "," + a[3] + ")";
      b.addEventListener("click", () => { look.accent = i; applyAppearance(); persist(); });
      al.append(b);
    });
  }
  (darkMQ.addEventListener ? darkMQ.addEventListener.bind(darkMQ, "change") : darkMQ.addListener.bind(darkMQ))(() => { if (look.theme === "system") applyAppearance(); });

  /* ------------------------------------------------------------------ *
   * Pop-up windows (blurred background)                                *
   * ------------------------------------------------------------------ */
  function openModal(id) {
    const m = $("#" + id);
    if (id === "modal-opts") { $("#mo-title").textContent = nav.view === "batch" ? "Batch Options" : "Cleaning Options"; $("#o-actions").hidden = nav.view === "batch"; }
    if (id === "modal-hf") $("#hf-hide").hidden = nav.view === "batch";
    if (id === "modal-areas") $("#ar-draw").hidden = nav.view === "batch";
    m.hidden = false; m._t = Date.now(); document.body.classList.add("modal-open");
    (m.querySelector("[data-close]") || m).focus?.();
  }
  function closeModal(m, opt) {
    if (m.hidden) return;
    m.hidden = true; m.dispatchEvent(new Event("modalclose"));
    const parent = m.dataset.parent;
    if (parent && !(opt && opt.noParent)) { if (parent === "modal-opts") openOptions(); else openModal(parent); return; }
    if (!$(".modal:not([hidden])")) document.body.classList.remove("modal-open");
  }
  $$(".modal").forEach((m) => m.addEventListener("click", (e) => {
    if (Date.now() - (m._t || 0) < 350) return;
    if (e.target === m || e.target.closest("[data-close]")) closeModal(m);
  }));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { const m = $(".modal:not([hidden])"); if (m) closeModal(m); } });
  $("#open-disclaimer").addEventListener("click", () => openModal("modal-disclaimer"));


  /* ------------------------------------------------------------------ *
   * Viewer: options sheet, analysis box, bubble, swipe                 *
   * ------------------------------------------------------------------ */
  $("#an-chips-slot").appendChild(el.chips);
  $("#viewer-back").addEventListener("click", () => { if (state.itemIdx != null) leaveItem(); else go("home"); });
  $("#an-clean").addEventListener("click", () => { closeModal($("#modal-analysis")); openNameDialog("clean"); });
  $("#an-copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("#an-report").textContent); toast("Copied"); } catch (e) { toast("Couldn't copy", true); }
  });

  (() => { // draggable eraser bubble
    const b = $("#bubble"), host = el.prevCard;
    let d = null, moved = false;
    b.addEventListener("pointerdown", (e) => {
      b.setPointerCapture(e.pointerId);
      const r = b.getBoundingClientRect();
      d = { ox: e.clientX - r.left, oy: e.clientY - r.top, x: e.clientX, y: e.clientY }; moved = false;
    });
    b.addEventListener("pointermove", (e) => {
      if (!d) return;
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6) moved = true;
      if (!moved) return;
      const h = b.classList.contains("in-batch") ? { left: 0, top: 0, width: innerWidth, height: innerHeight } : host.getBoundingClientRect();
      const x = Math.min(h.width - b.offsetWidth - 6, Math.max(6, e.clientX - d.ox - h.left));
      const y = Math.min(h.height - b.offsetHeight - 6, Math.max(6, e.clientY - d.oy - h.top));
      Object.assign(b.style, { left: x + "px", top: y + "px", right: "auto", bottom: "auto" });
    });
    b.addEventListener("pointerup", () => { d = null; });
    b.addEventListener("click", () => {
      if (moved) { moved = false; return; }
      if (b.disabled) return;
      if (state.hf) { setTool(null); openModal("modal-hf"); return; }
      if (state.drawing) {
        setTool(null);
        if (parseRegionsLenient(el.regions.value).length) openModal("modal-areas"); else openOptions();
        return;
      }
      openOptions();
    });
    b.addEventListener("pointercancel", () => { d = null; });
    window.addEventListener("resize", () => Object.assign(b.style, { left: "", top: "", right: "", bottom: "" }));
  })();

  /* ------------------------------------------------------------------ *
   * Pinch zoom, pan and double-tap on the preview                      *
   * ------------------------------------------------------------------ */
  const zoomG = { s: 1, tx: 0, ty: 0, pinch: false, panning: false, selecting: false, reset: null, refresh: null };
  /* keep the page on screen: centred when smaller than the stage, edge-limited when larger */
  function zoomClamp(s, tx, ty, d) {
    const cw = s * d.bw, ch = s * d.bh, ex = d.extra || 0;
    const x = cw <= d.W ? (d.W - cw) / 2 - s * d.bx : Math.min(-s * d.bx, Math.max(d.W - cw - s * d.bx, tx));
    let y;
    if (ch <= d.H) { const cy = (d.H - ch) / 2 - s * d.by; y = Math.min(cy + ex, Math.max(cy - ex, ty)); }
    else y = Math.min(-s * d.by + ex, Math.max(d.H - ch - s * d.by - ex, ty));
    return [x, y];
  }
  /* new translation that keeps the content point under the start midpoint under the current midpoint */
  function pinchTo(g, s, mx, my) { const k = s / g.s0; return [mx - (g.mx - g.tx0) * k, my - (g.my - g.ty0) * k]; }
  (() => {
    const stage = el.stage, wrap = $("#zoomwrap"), box = $("#pagebox"), hires = $("#hires");
    const MAX = 5, ptrs = new Map();
    let g = null, lastTap = null, hiT = 0, hiBusy = false, hiAgain = false, hiUrl = "";
    const dims = () => ({ W: stage.clientWidth, H: stage.clientHeight, bx: box.offsetLeft, by: box.offsetTop, bw: box.offsetWidth, bh: box.offsetHeight, extra: stage.clientHeight * 0.45 });
    const dist = () => { const [a, b] = [...ptrs.values()]; return Math.hypot(a.x - b.x, a.y - b.y) || 1; };
    const mid = () => { const [a, b] = [...ptrs.values()]; const r = stage.getBoundingClientRect(); return [(a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top]; };
    const local = (e) => { const r = stage.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

    function apply(s, tx, ty, smooth) {
      [tx, ty] = zoomClamp(s, tx, ty, dims());
      zoomG.s = s; zoomG.tx = tx; zoomG.ty = ty;
      wrap.style.transition = smooth ? "transform .2s ease-out" : "none";
      wrap.style.transform = s === 1 && Math.abs(tx) < 0.5 && Math.abs(ty) < 0.5 ? "" : "translate(" + tx + "px, " + ty + "px) scale(" + s + ")";
      wrap.style.setProperty("--zs", String(s));
      stage.classList.toggle("zoomed", s > 1.02);
      scheduleHires();
    }
    zoomG.reset = () => { g = null; ptrs.clear(); zoomG.pinch = false; zoomG.panning = false; apply(1, 0, 0, false); hideHires(); };
    zoomG.refresh = () => { hideHires(); scheduleHires(); };

    /* sharp tile of just the visible part, so text stays crisp when zoomed in */
    function hideHires() { clearTimeout(hiT); hires.hidden = true; hires.removeAttribute("src"); if (hiUrl) { URL.revokeObjectURL(hiUrl); hiUrl = ""; } }
    function scheduleHires() { clearTimeout(hiT); if (zoomG.s <= 1.25) { hideHires(); return; } hiT = setTimeout(renderHires, 260); }
    async function renderHires() {
      if (state.busy || el.prevImg.hidden) return;
      if (hiBusy) { hiAgain = true; return; }
      hiBusy = true;
      try {
        do {
          hiAgain = false;
          const path = state.previewSrc === "clean" ? state.cleanPath : state.inPath;
          if (!path || zoomG.s <= 1.25) break;
          const pw = state.previewSrc === "orig" ? state.pw : "";
          const sr = stage.getBoundingClientRect(), ir = el.prevImg.getBoundingClientRect();
          if (!ir.width || !ir.height) break;
          let fx0 = (sr.left - ir.left) / ir.width, fy0 = (sr.top - ir.top) / ir.height;
          let fx1 = (sr.right - ir.left) / ir.width, fy1 = (sr.bottom - ir.top) / ir.height;
          const mx = (fx1 - fx0) * 0.08, my = (fy1 - fy0) * 0.08;
          fx0 = Math.max(0, fx0 - mx); fy0 = Math.max(0, fy0 - my); fx1 = Math.min(1, fx1 + mx); fy1 = Math.min(1, fy1 + my);
          if (fx1 - fx0 < 0.02 || fy1 - fy0 < 0.02) break;
          const page = state.page, tok = state.previewToken;
          const target = Math.min(2000, Math.max(stage.clientWidth, stage.clientHeight) * Math.min(window.devicePixelRatio || 1, 2));
          const z = target / Math.max((fx1 - fx0) * state.pageW, (fy1 - fy0) * state.pageH, 1);
          const r = await rpc("preview", { path, password: pw, page, zoom: z, clip: [fx0, fy0, fx1, fy1].map((v) => v.toFixed(4)).join(",") });
          if (page !== state.page || tok !== state.previewToken || zoomG.s <= 1.25) continue;
          const url = URL.createObjectURL(new Blob([r.png], { type: "image/jpeg" }));
          Object.assign(hires.style, { left: fx0 * 100 + "%", top: fy0 * 100 + "%", width: (fx1 - fx0) * 100 + "%", height: (fy1 - fy0) * 100 + "%" });
          hires.src = url; hires.hidden = false;
          const old = hiUrl; hiUrl = url; if (old) setTimeout(() => URL.revokeObjectURL(old), 1500);
        } while (hiAgain);
      } catch (e) { /* the normal preview stays */ } finally { hiBusy = false; }
    }

    stage.addEventListener("pointerdown", (e) => {
      if (el.prevImg.hidden || e.target.closest(".hf-handle, .rx, .vnav")) return;
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t: performance.now() });
      if (ptrs.size === 2) {
        zoomG.pinch = true; stage.dispatchEvent(new Event("pinchstart"));
        const [mx, my] = mid();
        g = { type: "pinch", d0: dist(), s0: zoomG.s, tx0: zoomG.tx, ty0: zoomG.ty, mx, my };
      } else if (ptrs.size === 1 && !state.drawing && !zoomG.selecting && e.pointerType !== "mouse") {
        g = { type: "pan", id: e.pointerId, x0: e.clientX, y0: e.clientY, tx0: zoomG.tx, ty0: zoomG.ty, moved: false, fit: zoomG.s <= 1.02 };
      }
    }, true);
    stage.addEventListener("pointermove", (e) => {
      const p = ptrs.get(e.pointerId); if (!p) return;
      p.x = e.clientX; p.y = e.clientY;
      if (!g) return;
      if (g.type === "pinch" && ptrs.size >= 2) {
        const s = Math.min(MAX, Math.max(1, (g.s0 * dist()) / g.d0));
        const [mx, my] = mid(), [tx, ty] = pinchTo(g, s, mx, my);
        apply(s, tx, ty, false);
      } else if (g.type === "pan" && g.id === e.pointerId) {
        if (zoomG.selecting) { g = null; zoomG.panning = false; return; }
        const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
        if (!g.moved) {
          if (Math.hypot(dx, dy) < 8) return;
          if (g.fit && Math.abs(dy) <= Math.abs(dx) * 1.2) { g = null; return; }
          g.moved = true; zoomG.panning = true;
        }
        apply(zoomG.s, g.fit ? zoomG.tx : g.tx0 + dx, g.ty0 + dy, false);
      }
    }, true);
    const up = (e) => {
      const p = ptrs.get(e.pointerId); if (!p) return;
      const wasOnly = ptrs.size === 1, moved = Math.hypot(e.clientX - p.x0, e.clientY - p.y0);
      ptrs.delete(e.pointerId);
      if (g && g.type === "pan" && g.id === e.pointerId) zoomG.panning = false;
      if (g && g.type === "pinch") {
        if (ptrs.size < 2) {
          zoomG.pinch = false; zoomG.panning = false;
          if (zoomG.s < 1.05) apply(1, 0, 0, true);
          const rest = [...ptrs.entries()][0];
          g = rest ? { type: "pan", id: rest[0], x0: rest[1].x, y0: rest[1].y, tx0: zoomG.tx, ty0: zoomG.ty, moved: true, fit: false } : null;
        }
        return;
      }
      if (g && g.type === "pan" && g.id === e.pointerId) g = null;
      /* double tap: toggle between fit and 2.5x at the tap point */
      if (wasOnly && e.type === "pointerup" && e.pointerType !== "mouse" && !state.drawing && moved < 10 && performance.now() - p.t < 300) {
        const now = performance.now();
        if (lastTap && now - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
          lastTap = null;
          if (zoomG.s > 1.2) apply(1, 0, 0, true);
          else { const [px, py] = local(e), k = 2.5 / zoomG.s; apply(2.5, px - (px - zoomG.tx) * k, py - (py - zoomG.ty) * k, true); }
        } else lastTap = { t: now, x: e.clientX, y: e.clientY };
      }
    };
    stage.addEventListener("pointerup", up, true);
    stage.addEventListener("pointercancel", up, true);

    /* computer: Ctrl + wheel zooms, wheel pans when zoomed, + / - / 0 keys */
    stage.addEventListener("wheel", (e) => {
      if (el.prevImg.hidden) return;
      const [px, py] = local(e);
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const s = Math.min(MAX, Math.max(1, zoomG.s * Math.exp(-e.deltaY * 0.01))), k = s / zoomG.s;
        apply(s, px - (px - zoomG.tx) * k, py - (py - zoomG.ty) * k, false);
      } else { e.preventDefault(); apply(zoomG.s, zoomG.s > 1.02 ? zoomG.tx - e.deltaX : zoomG.tx, zoomG.ty - e.deltaY, false); }
    }, { passive: false });
    document.addEventListener("keydown", (e) => {
      if (!document.body.classList.contains("viewer-open") || $(".modal:not([hidden])") || el.prevImg.hidden) return;
      const c = [stage.clientWidth / 2, stage.clientHeight / 2];
      const zoomTo = (s) => { s = Math.min(MAX, Math.max(1, s)); const k = s / zoomG.s; apply(s, c[0] - (c[0] - zoomG.tx) * k, c[1] - (c[1] - zoomG.ty) * k, true); };
      if (e.key === "+" || e.key === "=") zoomTo(zoomG.s * 1.4);
      else if (e.key === "-") zoomTo(zoomG.s / 1.4);
      else if (e.key === "0") zoomG.reset();
    });
    window.addEventListener("resize", () => apply(zoomG.s, zoomG.tx, zoomG.ty, false));
  })();

  (() => { // swipe left / right to change pages
    const box = $("#pagebox");
    let s0 = null, dx = 0;
    el.stage.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" || zoomG.s > 1.02 || zoomG.selecting || state.drawing || el.prevImg.hidden || e.target.closest(".vnav, .hf-handle")) return;
      s0 = { x: e.clientX }; dx = 0; box.style.transition = "none";
    });
    el.stage.addEventListener("pointermove", (e) => { if (!s0) return; if (zoomG.panning || zoomG.selecting) { s0 = null; dx = 0; box.style.transition = ""; box.style.transform = ""; return; } dx = e.clientX - s0.x; box.style.transform = "translateX(" + dx * 0.6 + "px)"; });
    const end = () => {
      if (!s0) return;
      s0 = null; box.style.transition = ""; box.style.transform = "";
      if (dx < -70 && state.page < state.pages - 1) { state.page++; loadPreview(); }
      else if (dx > 70 && state.page > 0) { state.page--; loadPreview(); }
      dx = 0;
    };
    el.stage.addEventListener("pointerup", end);
    el.stage.addEventListener("pointercancel", end);
    el.stage.addEventListener("pinchstart", () => { s0 = null; dx = 0; box.style.transition = ""; box.style.transform = ""; });
    document.addEventListener("keydown", (e) => {
      if (!document.body.classList.contains("viewer-open") || $(".modal:not([hidden])")) return;
      if (e.key === "ArrowRight") el.pgNext.click(); else if (e.key === "ArrowLeft") el.pgPrev.click();
    });
  })();


  /* Eraser menu: five options, each opens its own window */
  function refreshOptStates() {
    const n = (v) => parseFloat(String(v || "0").replace(",", ".")) || 0;
    const t = n(el.top.value), b = n(el.bottom.value);
    $("#o-hf-s").textContent = state.hf ? "Active" : t || b ? "Header " + t + "%, footer " + b + "%" : "Pull the bars on the page";
    const a = parseRegionsLenient(el.regions.value).length;
    $("#draw-state").textContent = state.drawing ? "Active" : a ? a + (a > 1 ? " areas" : " area") : "Draw on the page";
    const tx = [el.header, el.footer].filter((x) => x.value.trim()).length;
    $("#o-text-s").textContent = tx ? tx + " set" : "None";
    const wm = el.watermark.value.split(";").filter((x) => x.trim()).length + (el.xrefs.value.trim() ? 1 : 0) + (el.imgWm.checked ? 1 : 0);
    $("#o-wm-s").textContent = wm ? wm + " on" : "None";
    const ot = [el.meta, el.annots, el.links, el.extras, el.hidden].filter((x) => x.checked).length;
    $("#o-other-s").textContent = ot ? ot + " on" : "None";
  }
  function openOptions() { refreshOptStates(); openModal("modal-opts"); }
  const optsModal = $("#modal-opts");
  const fresh = () => Date.now() - (optsModal._t || 0) < 400;
  const viaMenu = (id, fn) => $("#" + id).addEventListener("click", () => { if (fresh()) return; closeModal(optsModal); fn(); });
  viaMenu("o-hf", () => { if (nav.view === "batch" || state.hf) openModal("modal-hf"); else setTool("hf"); });
  el.draw.addEventListener("click", () => { if (fresh()) return; closeModal(optsModal); if (nav.view === "batch" || state.drawing || el.regions.value.trim()) openModal("modal-areas"); else setTool("draw"); });
  $("#o-analyze").addEventListener("click", () => { if (fresh()) return; closeModal(optsModal); el.btnAnalyze.click(); });
  viaMenu("o-text", () => openModal("modal-text"));
  viaMenu("o-wm", () => openModal("modal-wm"));
  viaMenu("o-other", () => openModal("modal-other"));
  $("#hf-hide").addEventListener("click", () => { setTool(null); closeModal($("#modal-hf")); });
  $("#ar-draw").addEventListener("click", () => { closeModal($("#modal-areas"), { noParent: true }); setTool("draw"); });
  $("#ar-clear").addEventListener("click", () => { el.regions.value = ""; el.regions.dispatchEvent(new Event("input")); });


  /* ------------------------------------------------------------------ *
   * Confirm window, limits, cancel                                     *
   * ------------------------------------------------------------------ */
  function confirmBox({ title, text, ok = "Continue", cancel = "Cancel" }) {
    return new Promise((resolve) => {
      const m = $("#modal-confirm"), okB = $("#mc-ok"), noB = $("#mc-cancel");
      $("#mc-title").textContent = title; $("#mc-text").textContent = text;
      okB.textContent = ok; noB.textContent = cancel || ""; noB.hidden = !cancel;
      let done = false;
      const finish = (v) => { if (done) return; done = true; m.removeEventListener("modalclose", onClose); resolve(v); closeModal(m); };
      const onClose = () => finish(false);
      m.addEventListener("modalclose", onClose);
      okB.onclick = () => finish(true);
      noB.onclick = () => finish(false);
      openModal("modal-confirm");
    });
  }
  const tooBig = (file, pages) => (file && file.size > MAX_MB * MB) || pages > MAX_PAGES;
  const limitText = () => "This device can open PDFs up to " + MAX_MB + " MB or " + MAX_PAGES + " pages. Split the file into smaller parts and try again.";
  const isHuge = (file, pages) => !!file && (pages >= HUGE_PAGES || file.size >= HUGE_MB * MB);

  async function restartEngine() {
    const err = new Error("Cancelled"); err.cancelled = true;
    try { worker.terminate(); } catch (e) { /* ignore */ }
    pending.forEach((p) => p.reject(err)); pending.clear();
    startWorker(); state.engineGen++;
    try { await rpc("init"); } catch (e) { /* shown on next use */ }
  }
  function cancelJob() {
    if (!state.busy || state.restartP) return;
    state.cancelled = true;
    $("#busy-cancel").disabled = true;
    el.ovlDetail.textContent = "Stopping…";
    state.restartP = restartEngine().finally(() => { state.restartP = null; });
  }
  $("#busy-cancel").addEventListener("click", cancelJob);
  async function afterCancel(keepBatch) {
    if (state.restartP) await state.restartP;
    state.cancelled = false; state.batch = null;
    const wasItem = state.itemIdx != null;
    state.stash = null;
    Object.assign(state, { file: null, inPath: null, cleanPath: null, cleanName: null, locked: false, pages: 0, unlocked: false, ucKey: null, pw: "" });
    if (state.itemMode || wasItem) { state.itemMode = false; state.itemIdx = null; if (state.globalSnap) { applyOptions(state.globalSnap); state.globalSnap = null; } }
    el.prevImg.hidden = true; setTool(null);
    setBusy(false, "Cancelled");
    syncViewer(); syncUploadItem();
    if (keepBatch || wasItem) { go("batch"); toast("Cancelled"); }
    else { go("home"); toast("Cancelled. Choose the PDF again to retry."); }
  }

  /* ------------------------------------------------------------------ *
   * Saved unlocked PDFs (IndexedDB, this device only)                  *
   * ------------------------------------------------------------------ */
  const UC = { db: null, MAX_N: 3, MAX_BYTES: 150 * MB, MAX_ONE: 60 * MB };
  const ucReq = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const ucDone = (tx) => new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
  function ucDb() {
    return new Promise((res, rej) => {
      if (UC.db) return res(UC.db);
      const r = indexedDB.open("pdfcleaner-unlocked", 1);
      r.onupgradeneeded = () => { r.result.createObjectStore("meta", { keyPath: "key" }); r.result.createObjectStore("files", { keyPath: "key" }); };
      r.onsuccess = () => { UC.db = r.result; res(UC.db); };
      r.onerror = () => rej(r.error);
    });
  }
  async function ucGet(key) {
    try {
      const db = await ucDb();
      const rec = await ucReq(db.transaction("files").objectStore("files").get(key));
      if (!rec) return null;
      const ms = db.transaction("meta", "readwrite").objectStore("meta");
      const m = await ucReq(ms.get(key));
      if (m) { m.t = Date.now(); ms.put(m); }
      return rec.buffer;
    } catch (e) { return null; }
  }
  async function ucEvict() {
    const db = await ucDb();
    const metas = await ucReq(db.transaction("meta").objectStore("meta").getAll());
    metas.sort((a, b) => b.t - a.t);
    let total = 0; const drop = [];
    metas.forEach((m, i) => { total += m.size; if (i >= UC.MAX_N || total > UC.MAX_BYTES) drop.push(m.key); });
    if (!drop.length) return;
    const tx = db.transaction(["meta", "files"], "readwrite");
    drop.forEach((k) => { tx.objectStore("meta").delete(k); tx.objectStore("files").delete(k); });
    await ucDone(tx);
  }
  async function ucPut(key, name, buffer) {
    try {
      if (buffer.byteLength > UC.MAX_ONE) return;
      const db = await ucDb();
      const tx = db.transaction(["meta", "files"], "readwrite");
      tx.objectStore("meta").put({ key, name, size: buffer.byteLength, t: Date.now() });
      tx.objectStore("files").put({ key, buffer });
      await ucDone(tx);
      await ucEvict();
    } catch (e) { /* ignore */ }
  }
  async function ucDel(key) {
    try {
      const db = await ucDb();
      const tx = db.transaction(["meta", "files"], "readwrite");
      tx.objectStore("meta").delete(key); tx.objectStore("files").delete(key);
      await ucDone(tx);
    } catch (e) { /* ignore */ }
  }
  async function ucClear() {
    try {
      const db = await ucDb();
      const tx = db.transaction(["meta", "files"], "readwrite");
      tx.objectStore("meta").clear(); tx.objectStore("files").clear();
      await ucDone(tx);
    } catch (e) { /* ignore */ }
  }
  async function ucCount() {
    try { const db = await ucDb(); return await ucReq(db.transaction("meta").objectStore("meta").count()); } catch (e) { return 0; }
  }
  async function refreshUc() {
    const n = await ucCount();
    $("#uc-label").textContent = n ? "Forget unlocked PDFs (" + n + ")" : "No unlocked PDFs saved";
    $("#uc-clear").disabled = !n;
  }
  $("#uc-clear").addEventListener("click", async () => { await ucClear(); await refreshUc(); toast("Unlocked PDFs forgotten"); });
  async function saveUnlockedCopy(file, key, path, pw) {
    try {
      setStatus("Saving an unlocked copy…");
      const out = "/in/unlocked/" + safeName(file.name);
      await rpc("job", { job: { kind: "unlock", input: path, output: out, password: pw } });
      const got = await rpc("get", { path: out });
      await rpc("rm", { paths: [path] });
      state.inPath = out; state.pw = ""; state.unlocked = true; state.ucKey = key;
      ucPut(key, file.name, got.buffer);
    } catch (err) {
      if (err && err.cancelled) throw err;
    }
  }

  /* ------------------------------------------------------------------ *
   * Analysis summary                                                   *
   * ------------------------------------------------------------------ */
  function plannedActions() {
    const n = (v) => parseFloat(String(v || "0").replace(",", ".")) || 0;
    const out = [];
    if (el.meta.checked) out.push("Metadata");
    if (el.annots.checked) out.push("Annotations");
    if (el.links.checked) out.push("Links");
    if (el.extras.checked) out.push("Attachments");
    if (el.hidden.checked) out.push("Hidden text");
    if (n(el.top.value)) out.push("Header " + n(el.top.value) + "%");
    if (n(el.bottom.value)) out.push("Footer " + n(el.bottom.value) + "%");
    const a = parseRegionsLenient(el.regions.value).length;
    if (a) out.push(a + (a > 1 ? " areas" : " area"));
    if (el.header.value.trim()) out.push("Header text");
    if (el.footer.value.trim()) out.push("Footer text");
    if (el.watermark.value.trim()) out.push("Watermark text");
    if (el.imgWm.checked || el.xrefs.value.trim()) out.push("Image watermarks");
    return out;
  }
  function renderAnalysis(text) {
    const num = (re) => { const m = text.match(re); return m ? Number(m[1]) : null; };
    const pages = num(/^Pages:\s*(\d+)/m), chars = num(/^Selectable text characters:\s*(\d+)/m);
    const annots = num(/^Annotations\/stamps:\s*(\d+)/m), links = num(/^Hyperlinks:\s*(\d+)/m), atts = num(/^Embedded attachments:\s*(\d+)/m);
    const hidden = num(/^Hidden\/tracker text spans:\s*(\d+)/m), mfields = num(/^Standard metadata fields with values:\s*(\d+)/m);
    const hasMeta = /^XMP metadata:\s*found/im.test(text) || mfields > 0;
    const images = (text.match(/^\s*XRef \d+:/gm) || []).length;
    const tiles = [
      ["Pages", pages == null ? "?" : pages, ""],
      ["Text characters", chars === 0 ? "None" : chars == null ? "?" : chars.toLocaleString(), chars === 0 ? "warn" : ""],
      ["Annotations", annots || 0, annots ? "warn" : "ok"],
      ["Links", links || 0, links ? "warn" : "ok"],
      ["Attachments", atts || 0, atts ? "warn" : "ok"],
      ["Metadata", hasMeta ? "Found" : "None", hasMeta ? "warn" : "ok"],
      ["Hidden text", hidden || 0, hidden ? "warn" : "ok"],
      ["Images", images, ""],
    ];
    const grid = $("#an-grid"); grid.textContent = "";
    tiles.forEach(([label, value, tone]) => {
      const t = document.createElement("div"); t.className = "an-tile" + (tone ? " " + tone : "");
      const b = document.createElement("b"); b.textContent = String(value);
      const sp = document.createElement("span"); sp.textContent = label;
      t.append(b, sp); grid.append(t);
    });
    $("#an-sub").textContent = state.file ? state.file.name + (pages ? " · " + pages + " pages" : "") : "";
    const m = text.match(/Configured text phrase scan:\n((?:[ \t]+.*\n?)+)/);
    const ul = $("#an-matches"); ul.textContent = "";
    if (m) m[1].split("\n").map((l) => l.trim()).filter(Boolean).forEach((l) => { const li = document.createElement("li"); li.textContent = l; ul.append(li); });
    ul.hidden = !ul.children.length;
    const plan = $("#an-plan"); plan.textContent = "";
    const list = plannedActions();
    (list.length ? list : ["Nothing selected"]).forEach((x) => {
      const c = document.createElement("span"); c.className = "an-chip" + (list.length ? "" : " none"); c.textContent = x; plan.append(c);
    });
  }


  /* ------------------------------------------------------------------ *
   * Batch: list, passwords, per-file options, clean all                *
   * ------------------------------------------------------------------ */
  const batch = { items: [], seq: 0 };
  const SINGLE_FIELDS = ["file", "inPath", "cleanPath", "cleanName", "locked", "unlocked", "ucKey", "pw", "pages", "page", "previewSrc"];
  const OPT_KEYS = ["top", "bottom", "regions", "header", "footer", "watermark", "imgWm", "xrefs", "meta", "annots", "links", "extras", "hidden"];
  function snapOptions() { const s = readSettings(); return Object.fromEntries(OPT_KEYS.map((k) => [k, s[k]])); }
  function applyOptions(o) {
    el.top.value = o.top; el.bottom.value = o.bottom; el.regions.value = o.regions; el.header.value = o.header; el.footer.value = o.footer;
    el.watermark.value = o.watermark; el.imgWm.checked = !!o.imgWm; el.xrefs.value = o.xrefs;
    el.meta.checked = !!o.meta; el.annots.checked = !!o.annots; el.links.checked = !!o.links; el.extras.checked = !!o.extras; el.hidden.checked = !!o.hidden;
    syncRange(el.top, el.topRange); syncRange(el.bottom, el.bottomRange); renderOverlay(); renderXrefChips();
  }
  const sameOpts = (a, b) => OPT_KEYS.every((k) => a[k] === b[k]);
  function uniqueName(used, name) {
    let n = name, i = 2;
    const stem = name.replace(/\.pdf$/i, "");
    while (used.has(n.toLowerCase())) n = stem + "_" + i++ + ".pdf";
    used.add(n.toLowerCase());
    return n;
  }
  function passwordCandidates(own, spares) { return [...new Set([own, ...spares].filter(Boolean))]; }
  const isLocked = (it) => it.locked && !it.unlocked;

  async function loadItem(item) {
    item.orig = "/in/batch/" + item.id + "_" + safeName(item.name);
    const cached = await ucGet(item.key);
    const buf = cached || (await item.file.arrayBuffer());
    await rpc("put", { path: item.orig, buffer: buf }, [buf]);
    item.work = item.orig; item.gen = state.engineGen;
    if (cached) { item.locked = true; item.unlocked = true; return; }
    const prot = await rpc("protected", { path: item.orig });
    item.locked = prot.protected; item.unlocked = false;
  }
  async function thumbFor(item) {
    if (isLocked(item)) return;
    const r = await rpc("preview", { path: item.work, password: "", page: 0, zoom: 0.3 });
    if (item.thumb) URL.revokeObjectURL(item.thumb);
    item.thumb = URL.createObjectURL(new Blob([r.png], { type: "image/jpeg" }));
    item.pages = r.pages;
  }
  async function unlockItem(item, pw) {
    await rpc("preview", { path: item.orig, password: pw, page: 0, zoom: 0.2 });
    const out = "/in/batch/" + item.id + "_u_" + safeName(item.name);
    await rpc("job", { job: { kind: "unlock", input: item.orig, output: out, password: pw } });
    const got = await rpc("get", { path: out });
    await rpc("rm", { paths: [item.orig] });
    item.work = out; item.unlocked = true; item.pw = pw;
    ucPut(item.key, item.name, got.buffer);
    await thumbFor(item);
  }
  async function ensureItem(item) {
    if (item.gen === state.engineGen) return;
    const pw = item.pw;
    await loadItem(item);
    if (isLocked(item) && pw) await unlockItem(item, pw);
  }

  async function addBatchFiles(list) {
    const have = new Set(batch.items.map((i) => i.key));
    let files = list.filter((f) => isPdf(f) && !/_clean$/i.test(stemOf(f.name)));
    files = files.filter((f) => !have.has(f.name + "|" + f.size + "|" + f.lastModified));
    files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    if (!files.length) { toast("No new PDFs to add.", true); return; }
    const tooLarge = files.filter((f) => f.size > MAX_MB * MB);
    files = files.filter((f) => f.size <= MAX_MB * MB);
    const total = files.reduce((a, f) => a + f.size, 0) + batch.items.reduce((a, i) => a + i.file.size, 0);
    if (batch.items.length + files.length > MAX_BATCH_FILES || total > MAX_BATCH_MB * MB) {
      await confirmBox({ title: "Too many files", text: "Up to " + MAX_BATCH_FILES + " PDFs or " + MAX_BATCH_MB + " MB at a time.", ok: "OK", cancel: null });
      return;
    }
    if ((files.length >= BATCH_FILES || total >= BATCH_MB * MB) && !(await confirmBox({ title: "Large batch", text: files.length + " PDFs (" + fmtSize(total) + "). Adding them may take a while.", ok: "Add" }))) return;
    setBusy(true, "Adding PDFs…", "Adding PDFs");
    const failed = [];
    try {
      for (let k = 0; k < files.length; k++) {
        const f = files[k];
        setStatus((k + 1) + " of " + files.length + ": " + f.name); setProgress((k / files.length) * 100);
        const it = { id: ++batch.seq, file: f, name: f.name, key: f.name + "|" + f.size + "|" + f.lastModified, pages: 0, locked: false, unlocked: false, pw: "", thumb: "", opts: null, status: "", error: "" };
        try { await loadItem(it); await thumbFor(it); batch.items.push(it); } catch (err) { if (err.cancelled) throw err; failed.push(f.name); }
      }
    } finally { setBusy(false, "Ready"); }
    renderBatch(); syncBatchItem();
    if (tooLarge.length || failed.length) toast((tooLarge.length + failed.length) + " file(s) skipped (too large or unreadable).", true);
    if (batch.items.some(isLocked)) openPasswords();
  }

  function renderBatch() {
    const list = $("#batch-list"); list.textContent = "";
    batch.items.forEach((it, i) => {
      const li = document.createElement("li"); li.className = "b-item"; li.tabIndex = 0;
      const num = document.createElement("span"); num.className = "b-num"; num.textContent = String(i + 1);
      const th = document.createElement("span"); th.className = "b-thumb";
      if (it.thumb) { const im = document.createElement("img"); im.src = it.thumb; im.alt = ""; th.append(im); }
      else th.innerHTML = '<svg class="ic"><use href="#i-lock"/></svg>';
      const info = document.createElement("span"); info.className = "b-info";
      const nm = document.createElement("b"); nm.textContent = it.name;
      const sm = document.createElement("small");
      const bits = [fmtSize(it.file.size)];
      if (it.pages) bits.push(it.pages + (it.pages === 1 ? " page" : " pages"));
      let tone = "";
      if (isLocked(it)) { bits.push("Locked"); tone = "warn"; }
      else if (it.status === "done") { bits.push("Done"); tone = "ok"; }
      else if (it.status === "failed") { bits.push("Failed: " + it.error); tone = "warn"; }
      else if (it.opts) bits.push("Custom options");
      sm.textContent = bits.join(" · "); if (tone) sm.className = tone;
      info.append(nm, sm);
      const x = document.createElement("button"); x.type = "button"; x.className = "b-x"; x.setAttribute("aria-label", "Remove " + it.name);
      x.innerHTML = '<svg class="ic"><use href="#i-x"/></svg>';
      x.addEventListener("click", (e) => { e.stopPropagation(); removeItem(i); });
      li.append(num, th, info, x);
      li.addEventListener("click", () => openItem(i));
      li.addEventListener("keydown", (e) => { if (e.key === "Enter") openItem(i); });
      list.append(li);
    });
    const n = batch.items.length, locked = batch.items.filter(isLocked).length;
    $("#batch-empty").hidden = n > 0;
    $("#b-clean").disabled = !n || state.busy;
    $("#b-clean span").textContent = n ? "Clean all (" + n + ")" : "Clean all";
    $("#b-pw-badge").hidden = !locked; $("#b-pw-badge").textContent = String(locked);
  }
  function syncBatchItem() {
    const n = batch.items.length;
    $("#m-batch-sub").textContent = n ? n + (n > 1 ? " PDFs" : " PDF") + " · tap to open" : "Clean many files at once";
  }
  async function removeItem(i) {
    const it = batch.items[i]; if (!it || state.busy) return;
    try { await rpc("rm", { paths: [it.orig, it.work].filter(Boolean) }); } catch (e) { /* ignore */ }
    if (it.thumb) URL.revokeObjectURL(it.thumb);
    batch.items.splice(i, 1); renderBatch(); syncBatchItem();
  }
  async function clearBatch() {
    if (state.busy || !batch.items.length) return;
    if (!(await confirmBox({ title: "Remove all PDFs?", text: batch.items.length + " PDFs will be removed from the batch.", ok: "Remove" }))) return;
    try { await rpc("rm", { paths: batch.items.flatMap((i) => [i.orig, i.work]).filter(Boolean) }); } catch (e) { /* ignore */ }
    batch.items.forEach((i) => i.thumb && URL.revokeObjectURL(i.thumb));
    batch.items = []; renderBatch(); syncBatchItem();
  }

  /* Open one PDF of the batch in the normal single-PDF viewer */
  async function openItem(i) {
    if (state.busy) return;
    const it = batch.items[i]; if (!it) return;
    setBusy(true, "Opening " + it.name + "…", "Opening PDF");
    try {
      await ensureItem(it);
      if (isLocked(it)) {
        setBusy(false, "Password needed");
        const pw = await askPassword(it.name, (p) => unlockItem(it, p));
        if (pw === null) { renderBatch(); return; }
        setBusy(true, "Opening " + it.name + "…", "Opening PDF");
      }
      state.stash = Object.fromEntries(SINGLE_FIELDS.map((k) => [k, state[k]]));
      state.itemIdx = i; state.itemMode = true; state.globalSnap = snapOptions();
      if (it.opts) applyOptions(it.opts);
      Object.assign(state, { file: it.file, inPath: it.work, pw: "", pages: it.pages, page: 0, previewSrc: "orig", locked: it.locked, unlocked: !isLocked(it), ucKey: it.key, cleanPath: null, cleanName: null });
      go("upload", "single");
      el.prevCard.hidden = false; $("#vt-name").textContent = it.name; syncViewer();
      setSeg("orig"); el.seg.querySelector('[data-src="clean"]').disabled = true;
      await loadPreview();
      setBusy(false, "Ready");
    } catch (err) {
      if (err.cancelled) { await afterCancel(true); return; }
      setBusy(false, "Could not open the PDF"); toast(err.message, true);
      if (state.itemIdx != null) leaveItem();
    }
  }
  function leaveItem() {
    const i = state.itemIdx; if (i == null) return;
    const it = batch.items[i], cur = snapOptions();
    if (it) it.opts = sameOpts(cur, state.globalSnap) ? null : cur;
    setTool(null);
    Object.assign(state, state.stash || {});
    state.stash = null; state.itemIdx = null; state.itemMode = false;
    applyOptions(state.globalSnap); state.globalSnap = null;
    el.prevImg.hidden = true;
    el.seg.querySelector('[data-src="clean"]').disabled = !state.cleanPath;
    if (state.file) { setSeg(state.previewSrc || "orig"); loadPreview(); }
    syncUploadItem(); go("batch");
  }

  /* Passwords window */
  function openPasswords() {
    const locked = batch.items.map((it, i) => ({ it, i })).filter((x) => isLocked(x.it));
    const list = $("#bpw-list"); list.textContent = "";
    if (!locked.length) { toast("No locked PDFs."); return; }
    locked.forEach(({ it, i }) => {
      const li = document.createElement("li"); li.className = "bpw-row"; li.dataset.id = String(it.id);
      const num = document.createElement("span"); num.className = "b-num"; num.textContent = String(i + 1);
      const th = document.createElement("span"); th.className = "b-thumb"; th.innerHTML = '<svg class="ic"><use href="#i-lock"/></svg>';
      const main = document.createElement("span"); main.className = "bpw-main";
      const nm = document.createElement("span"); nm.textContent = it.name;
      const inp = document.createElement("input"); inp.type = $("#bpw-show").checked ? "text" : "password"; inp.placeholder = "Password for #" + (i + 1); inp.autocomplete = "off"; inp.autocapitalize = "off"; inp.spellcheck = false;
      const st = document.createElement("small"); st.textContent = "Locked";
      main.append(nm, inp, st); li.append(num, th, main); list.append(li);
    });
    openModal("modal-bpw");
  }
  function addSpareSlot() {
    const row = document.createElement("div"); row.className = "bpw-slot";
    const plus = document.createElement("span"); plus.className = "b-num"; plus.textContent = "+";
    const inp = document.createElement("input"); inp.type = $("#bpw-show").checked ? "text" : "password"; inp.placeholder = "Extra password"; inp.autocomplete = "off"; inp.autocapitalize = "off"; inp.spellcheck = false;
    const x = document.createElement("button"); x.type = "button"; x.className = "b-x"; x.setAttribute("aria-label", "Remove password"); x.innerHTML = '<svg class="ic"><use href="#i-x"/></svg>';
    x.addEventListener("click", () => row.remove());
    row.append(plus, inp, x); $("#bpw-spare").append(row); inp.focus();
  }
  $("#bpw-add").addEventListener("click", addSpareSlot);
  $("#bpw-show").addEventListener("change", (e) => { $$("#modal-bpw input[type=password], #modal-bpw input[type=text]").forEach((i) => { if (i.id !== "bpw-show") i.type = e.target.checked ? "text" : "password"; }); });
  $("#bpw-ok").addEventListener("click", async () => {
    if (state.busy) return;
    const btn = $("#bpw-ok"); btn.disabled = true;
    const spares = $$("#bpw-spare input").map((i) => i.value);
    try {
      for (const row of $$("#bpw-list .bpw-row")) {
        const it = batch.items.find((x) => String(x.id) === row.dataset.id); if (!it || !isLocked(it)) continue;
        const st = row.querySelector("small"), cands = passwordCandidates(row.querySelector("input").value, spares);
        if (!cands.length) { st.textContent = "Enter a password"; st.className = "bad"; continue; }
        st.textContent = "Checking…"; st.className = "";
        await ensureItem(it);
        let ok = false;
        for (const pw of cands) { try { await unlockItem(it, pw); ok = true; break; } catch (e) { if (e.cancelled) throw e; } }
        st.textContent = ok ? "Unlocked" : "Wrong password"; st.className = ok ? "ok" : "bad";
        if (ok) row.querySelector("input").disabled = true;
      }
    } finally { btn.disabled = false; renderBatch(); }
    if (!batch.items.some(isLocked)) { closeModal($("#modal-bpw")); toast("All PDFs unlocked"); }
  });
  $("#b-pw").addEventListener("click", () => { if (!state.busy) openPasswords(); });
  $("#b-add").addEventListener("click", () => { if (!state.busy) el.batchInput.click(); });
  $("#b-clear").addEventListener("click", clearBatch);
  el.batchInput.addEventListener("change", () => { const files = [...el.batchInput.files]; el.batchInput.value = ""; if (files.length) { go("batch"); addBatchFiles(files); } });

  /* Clean all */
  $("#b-clean").addEventListener("click", async () => {
    if (state.busy || !batch.items.length) return;
    const locked = batch.items.filter(isLocked).length;
    if (locked && await confirmBox({ title: "Locked PDFs", text: locked + " PDF" + (locked > 1 ? "s are" : " is") + " still locked.", ok: "Enter passwords", cancel: "Skip them" })) { openPasswords(); return; }
    openNameDialog("batch");
  });
  async function runBatch(suffix, folder) {
    const snap = snapOptions(), targets = batch.items.filter((it) => !isLocked(it));
    if (!targets.length) { toast("No unlocked PDFs to clean.", true); return; }
    state.itemMode = true; state.globalSnap = snap;
    try { targets.forEach((it) => { applyOptions(it.opts || snap); getOptions(); }); }
    catch (e) { state.itemMode = false; state.globalSnap = null; applyOptions(snap); toast(e.message, true); return; }
    setBusy(true, "Cleaning…", "Batch cleaning", batchNote(targets.map((t) => t.file)));
    startEta(0);
    const used = new Set(); let ok = 0, cancelled = false; const fails = [];
    for (let k = 0; k < targets.length; k++) {
      const it = targets[k];
      state.batch = { i: k + 1, n: targets.length };
      el.ovlTitle.textContent = "Cleaning PDF " + (k + 1) + " of " + targets.length;
      setStatus(it.name);
      try {
        await ensureItem(it);
        applyOptions(it.opts || snap);
        const opts = getOptions();
        const outName = uniqueName(used, safeName(stemOf(it.name) + suffix + ".pdf"));
        const outP = "/out/batch/" + it.id + "/" + outName;
        await rpc("job", { job: { kind: "clean", input: it.work, output: outP, password: "", options: opts } });
        const got = await rpc("get", { path: outP });
        await rpc("rm", { paths: [outP] });
        await saveBlob(new Blob([got.buffer], { type: "application/pdf" }), outName, true);
        it.status = "done"; it.error = ""; ok++;
      } catch (err) {
        if (err.cancelled) { cancelled = true; break; }
        it.status = "failed"; it.error = err.message; fails.push(it.name);
      }
    }
    if (cancelled) { await afterCancel(true); renderBatch(); return; }
    state.itemMode = false; state.globalSnap = null; applyOptions(snap); state.batch = null;
    $("#busy-cancel").hidden = true;
    setBusy(false, "Done"); renderBatch();
    await confirmBox({ title: ok + " of " + targets.length + " saved", text: fails.length ? "Failed: " + fails.slice(0, 3).join(", ") + (fails.length > 3 ? " and " + (fails.length - 3) + " more" : "") : "Saved to " + folder + ".", ok: "OK", cancel: null });
  }

  /* The options icon lives in the viewer; in the batch view it floats over the list */
  function placeBubble(view) {
    const b = $("#bubble"), inBatch = view === "batch";
    if (inBatch === b.classList.contains("in-batch")) return;
    (inBatch ? VIEWS.batch : el.prevCard).appendChild(b);
    b.classList.toggle("in-batch", inBatch);
    Object.assign(b.style, { left: "", top: "", right: "", bottom: "" });
  }

  /* Android back button (called from native) */
  window.__onBack = () => {
    if (state.busy) return true;
    const m = $(".modal:not([hidden])");
    if (m) { closeModal(m); return true; }
    if (state.itemIdx != null) { leaveItem(); return true; }
    if (nav.view !== "home") { go("home"); return true; }
    return false;
  };

  /* ------------------------------------------------------------------ *
   * Start                                                              *
   * ------------------------------------------------------------------ */
  loadSettings();
  initUpdates();
  if (NATIVE) el.bootNote.textContent = "Loading the PDF engine…";
  boot();
})();
