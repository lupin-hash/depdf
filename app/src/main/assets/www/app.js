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
  const DEFAULTS = {
    top: "0", bottom: "2", regions: "",
    header: "", footer: "",
    watermark: "", imgWm: true, xrefs: "",
    meta: true, annots: false, links: false, extras: false, hidden: false,
    autoUpdate: false,
    theme: "system", accent: 0,
  };
  const STORE_KEY = "pdfcleaner.settings.v1";

  const el = {
    boot: $("#boot"), bootStage: $("#boot-stage"), bootBar: $("#boot-bar"), bootNote: $("#boot-note"), bootRetry: $("#boot-retry"),
    app: $("#app"), bar: $("#actionbar"), pill: $("#pill"), pillText: $("#pill-text"),
    fileInput: $("#file-input"), batchInput: $("#batch-input"), drop: $("#drop"), dropTitle: $("#drop-title"), dropSub: $("#drop-sub"),
    chip: $("#filechip"), fname: $("#fname"), fsub: $("#fsub"), lock: $("#lockbadge"), changeFile: $("#change-file"),
    outName: $("#out-name"), password: $("#password"), pwToggle: $("#pw-toggle"),
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
    bigNote: $("#big-note"), bigNoteText: $("#big-note-text"),
    updCard: $("#card-update"), appVer: $("#app-ver"), updStatus: $("#upd-status"), updCheck: $("#upd-check"), updCheckLabel: $("#upd-check-label"),
    updGet: $("#upd-get"), updGetLabel: $("#upd-get-label"), updNotes: $("#upd-notes"), autoUpd: $("#opt-autoupd"),
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
    drawing: false, hf: false, outputs: [], previewToken: 0, previewUrl: null,
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
    el.ovlDetail.textContent = tidyPaths(t);
    const m = /page (\d+) of (\d+)/i.exec(t);
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
  function updateBigNote() {
    const n = bigFileNote(state.file, state.pages);
    el.bigNote.hidden = !n; el.bigNoteText.textContent = n;
  }

  function setBusy(busy, status, title, note) {
    state.busy = busy;
    if (!busy) state.batch = null;
    [el.btnAnalyze, el.btnClean, el.btnBatch, el.btnUnlock, $("#v-analyze"), $("#bubble")].forEach((b) => (b.disabled = busy));
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
      autoUpdate: el.autoUpd.checked,
      theme: look.theme, accent: look.accent,
    };
  }
  function applySettings(s) {
    el.top.value = s.top; el.bottom.value = s.bottom; el.regions.value = s.regions;
    el.header.value = s.header; el.footer.value = s.footer;
    el.watermark.value = s.watermark; el.imgWm.checked = !!s.imgWm; el.xrefs.value = s.xrefs;
    el.meta.checked = !!s.meta; el.annots.checked = !!s.annots; el.links.checked = !!s.links; el.extras.checked = !!s.extras; el.hidden.checked = !!s.hidden; el.autoUpd.checked = !!s.autoUpdate;
    look.theme = THEMES.some((t) => t.id === s.theme) ? s.theme : "system";
    look.accent = Number.isInteger(s.accent) ? s.accent : 0;
    applyAppearance();
    syncRange(el.top, el.topRange); syncRange(el.bottom, el.bottomRange);
    renderOverlay(); renderXrefChips();
  }
  function persist() { try { localStorage.setItem(STORE_KEY, JSON.stringify(readSettings())); } catch (e) { /* private mode */ } }
  function loadSettings() {
    let s = DEFAULTS;
    try { s = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE_KEY) || "{}") }; } catch (e) { /* ignore */ }
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
  [el.regions, el.header, el.footer, el.watermark, el.xrefs, el.imgWm, el.meta, el.annots, el.links, el.extras, el.hidden, el.autoUpd].forEach((n) =>
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
  el.pwToggle.addEventListener("click", () => {
    const show = el.password.type === "password";
    el.password.type = show ? "text" : "password";
    el.pwToggle.setAttribute("aria-pressed", String(show));
    el.pwToggle.setAttribute("aria-label", show ? "Hide password" : "Show password");
    el.pwToggle.firstElementChild.firstElementChild.setAttribute("href", show ? "#i-eye-off" : "#i-eye");
  });
  el.password.addEventListener("change", () => { if (state.file && state.locked) loadPreview(); });
  el.password.addEventListener("keydown", (e) => { if (e.key === "Enter") { el.password.blur(); } });

  /* ------------------------------------------------------------------ *
   * Choosing a file                                                    *
   * ------------------------------------------------------------------ */
  el.drop.addEventListener("click", () => el.fileInput.click());
  el.changeFile.addEventListener("click", () => el.fileInput.click());
  el.fileInput.addEventListener("change", () => { const f = el.fileInput.files[0]; el.fileInput.value = ""; if (f) selectFile(f); });
  ["dragenter", "dragover"].forEach((t) => el.drop.addEventListener(t, (e) => { e.preventDefault(); el.drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((t) => el.drop.addEventListener(t, (e) => { e.preventDefault(); el.drop.classList.remove("over"); }));
  el.drop.addEventListener("drop", (e) => { const f = e.dataTransfer?.files?.[0]; if (f) selectFile(f); });

  const isPdf = (f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf";

  async function selectFile(file) {
    if (state.busy) return;
    if (!isPdf(file)) { toast("The input file must be a PDF.", true); return; }
    state.pages = 0; el.bigNote.hidden = true; setTool(null);
    if (tooBig(file, 0)) { await confirmBox({ title: "PDF is too large", text: limitText(), ok: "OK", cancel: null }); if (!state.file) go("home"); return; }
    setBusy(true, "Opening " + file.name + "…", "Opening PDF", isBigFile(file, 0) ? bigFileNote(file, 0) : "");
    try {
      if (state.inPath) await rpc("rm", { paths: [state.inPath] });
      if (state.cleanPath) await rpc("rm", { paths: [state.cleanPath] });
      state.cleanPath = null; state.cleanName = null;
      clearOutputs();
      const buf = await file.arrayBuffer();
      const path = "/in/main/" + safeName(file.name);
      await rpc("put", { path, buffer: buf }, [buf]);
      state.file = file; state.inPath = path; state.page = 0; state.previewSrc = "orig";
      const prot = await rpc("protected", { path });
      state.locked = prot.protected;
      if (state.locked) {
        setBusy(false, "Password needed");
        const pw = await askPassword(file.name, (p) => rpc("preview", { path, password: p, page: 0, zoom: 0.2 }));
        if (pw === null) {
          try { await rpc("rm", { paths: [path] }); } catch (e) { /* ignore */ }
          state.file = null; state.inPath = null; el.password.value = "";
          go("home"); setBusy(false, "Ready"); return;
        }
        el.password.value = pw;
        setBusy(true, "Opening " + file.name + "…", "Opening PDF");
      } else { el.password.value = ""; }
      el.fname.textContent = file.name;
      el.fsub.textContent = fmtSize(file.size);
      el.chip.hidden = false; el.drop.hidden = true;
      el.lock.hidden = !state.locked;
      el.outName.value = stemOf(file.name) + "_clean.pdf";
      el.prevCard.hidden = false; $("#vt-name").textContent = file.name; syncViewer();
      setSeg("orig"); el.seg.querySelector('[data-src="clean"]').disabled = true;
      writeReport("Tap Analyze to scan this PDF.");
      await loadPreview();
      if (tooBig(null, state.pages)) {
        try { await rpc("rm", { paths: [state.inPath] }); } catch (e) { /* ignore */ }
        Object.assign(state, { file: null, inPath: null, pages: 0 }); el.prevImg.hidden = true; syncViewer(); setBusy(false, "Ready"); go("home");
        await confirmBox({ title: "PDF is too large", text: limitText(), ok: "OK", cancel: null }); return;
      }
      updateBigNote();
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

  async function loadPreview() {
    const token = ++state.previewToken;
    const path = state.previewSrc === "clean" ? state.cleanPath : state.inPath;
    if (!path) return;
    const needsPw = state.previewSrc === "orig" && state.locked && !el.password.value;
    if (needsPw) {
      el.prevImg.hidden = true;
      el.stageMsg.textContent = "This PDF is password-protected. Enter the password to see a preview.";
      el.pgLabel.textContent = "Locked"; el.pgPrev.disabled = el.pgNext.disabled = true; el.draw.disabled = true;
      return;
    }
    el.stageMsg.textContent = "Rendering…";
    try {
      const pw = state.previewSrc === "orig" ? el.password.value : "";
      const r = await rpc("preview", { path, password: pw, page: state.page, zoom: 1.8 });
      if (token !== state.previewToken) return;
      const url = URL.createObjectURL(new Blob([r.png], { type: "image/jpeg" }));
      const old = state.previewUrl; state.previewUrl = url;
      el.prevImg.src = url; el.prevImg.hidden = false;
      if (old) setTimeout(() => URL.revokeObjectURL(old), 2000);
      el.stageMsg.textContent = "";
      state.pages = r.pages; state.page = r.page; state.pageW = r.w; state.pageH = r.h;
      el.pgLabel.textContent = "Page " + (r.page + 1) + " of " + r.pages;
      el.pgPrev.disabled = r.page <= 0; el.pgNext.disabled = r.page >= r.pages - 1;
      el.draw.disabled = state.previewSrc === "clean";
      if (state.locked && state.previewSrc === "orig") el.lock.hidden = false;
      renderOverlay();
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
    parseRegionsLenient(el.regions.value).forEach(([x0, y0, x1, y1], i) =>
      mk("r", { left: x0 + "%", top: y0 + "%", width: x1 - x0 + "%", height: y1 - y0 + "%" }, String(i + 1)));
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
    $("#hf").hidden = !state.hf;
    $("#prev-hint").textContent = t === "draw" ? "Drag to draw. Tap here when done." : t === "hf" ? "Pull the arrows. Tap here when done." : "";
    el.prevCard.classList.toggle("has-hint", !!t);
    if (state.hf) positionHandles();
  }
  const toggleDraw = (on) => setTool(on ? "draw" : null);
  $("#prev-hint").addEventListener("click", () => setTool(null));
  ["t", "f"].forEach((w) => {
    const node = $("#hf-" + w);
    let on = false, off = 0;
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
      if (t.value !== String(pct)) { t.value = String(pct); t.dispatchEvent(new Event("input")); }
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
      const r = await rpc("job", { job: { kind: "analyze", input, password: el.password.value, watermark: el.watermark.value, header: el.header.value, footer: el.footer.value } });
      writeReport(r.report);
      lastXrefs = parseXrefs(r.report); renderXrefChips();
      setBusy(false, "Analysis complete"); openModal("modal-analysis");
    } catch (err) { if (err.cancelled) { await afterCancel(false); return; } fail("Analysis failed", err); }
  });

  /* ------------------------------------------------------------------ *
   * Clean / unlock: name box -> choose folder -> run -> save           *
   * ------------------------------------------------------------------ */
  const SUFFIX = { clean: "_clean", unlock: "_unlocked" };
  const nameCtx = { kind: "clean" };
  const previewName = () => safeName(stemOf(state.file.name) + ($("#nm-suffix").value.trim() || SUFFIX[nameCtx.kind]) + ".pdf");

  function pickFolder() {
    if (!NATIVE || typeof NATIVE.pickFolder !== "function") return Promise.resolve("Downloads");
    return new Promise((resolve) => {
      window.__onFolderPicked = (json) => { let r = {}; try { r = JSON.parse(json); } catch (e) { /* ignore */ } resolve(r.ok ? r.name || "folder" : null); };
      NATIVE.pickFolder();
    });
  }
  async function saveBlob(blob, name) {
    if (NATIVE && typeof NATIVE.pickFolder === "function") await nativeSend(blob, name, "folder");
    else download(blob, name);
  }
  function openNameDialog(kind) {
    if (state.busy) return;
    try { requireInput(); if (kind === "clean") getOptions(); } catch (e) { toast(e.message, true); return; }
    nameCtx.kind = kind;
    $("#nm-suffix").value = SUFFIX[kind];
    $("#nm-preview").textContent = previewName();
    $("#mn-title").textContent = kind === "unlock" ? "Name the unlocked copy" : "Name your cleaned copy";
    openModal("modal-name");
  }
  $("#nm-suffix").addEventListener("input", () => { $("#nm-preview").textContent = previewName(); });
  $("#nm-save").addEventListener("click", async () => {
    const name = previewName(), kind = nameCtx.kind;
    closeModal($("#modal-name"));
    const folder = await pickFolder();
    if (!folder) { toast("Choose a folder to save."); openModal("modal-name"); return; }
    await runSave(kind, name, folder);
  });

  async function runSave(kind, name, folder) {
    const input = state.inPath, password = el.password.value;
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

  el.btnBatch.addEventListener("click", () => { if (!state.busy) el.batchInput.click(); });
  el.batchInput.addEventListener("change", async () => {
    const all = [...el.batchInput.files]; el.batchInput.value = "";
    if (!all.length || state.busy) return;
    let opts;
    try { opts = getOptions(); } catch (e) { toast(e.message, true); return; }
    const files = all.filter((f) => isPdf(f) && !/_clean$/i.test(stemOf(f.name))).sort((a, b) => a.name.localeCompare(b.name));
    if (!files.length) {
      writeReport("No source PDFs were selected. Files already named *_clean.pdf are skipped.");
      toast("No source PDFs were selected. Files named *_clean.pdf are skipped.", true); return;
    }
    const total = files.reduce((a, f) => a + f.size, 0);
    if (files.length > MAX_BATCH_FILES || total > MAX_BATCH_MB * MB) {
      await confirmBox({ title: "Too many files", text: "Up to " + MAX_BATCH_FILES + " PDFs or " + MAX_BATCH_MB + " MB at a time. You chose " + files.length + " (" + fmtSize(total) + "). Select fewer.", ok: "OK", cancel: null });
      return;
    }
    if ((files.length >= BATCH_FILES || total >= BATCH_MB * MB) && !(await confirmBox({ title: "Large batch", text: files.length + " PDFs (" + fmtSize(total) + ") run one by one and may take a while. Keep the app open.", ok: "Start" }))) return;
    const password = el.password.value;
    state.batch = { i: 1, n: files.length };
    setBusy(true, `Batch cleaning ${files.length} PDF(s)…`, "Batch cleaning", batchNote(files));
    startEta(0);
    writeReport(`Batch started: ${files.length} PDF(s)\n`);
    clearOutputs();
    const done = []; let fails = 0, cancelled = false;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (f.size > MAX_MB * MB) { fails++; writeReport(`SKIPPED: ${f.name}: too large (limit ${MAX_MB} MB)\n`, true); addOutput({ name: f.name, blob: null, error: "Too large for this device" }); continue; }
      const outName = safeName(stemOf(f.name) + "_clean.pdf");
      const inP = `/in/b${i}/${safeName(f.name)}`, outP = `/out/b${i}/${outName}`;
      state.batch = { i: i + 1, n: files.length };
      el.ovlTitle.textContent = `Cleaning PDF ${i + 1} of ${files.length}`;
      setStatus(`${f.name}`);
      try {
        const buf = await f.arrayBuffer();
        await rpc("put", { path: inP, buffer: buf }, [buf]);
        const r = await rpc("job", { job: { kind: "clean", input: inP, output: outP, password, options: opts } });
        const got = await rpc("get", { path: outP });
        const blob = new Blob([got.buffer], { type: "application/pdf" });
        done.push({ name: outName, blob });
        addOutput({ name: outName, blob });
        writeReport(r.report + "\n", true);
      } catch (err) {
        if (err.cancelled) { cancelled = true; break; }
        fails++;
        writeReport(`FAILED: ${f.name}: ${err.message}\n`, true);
        addOutput({ name: f.name, blob: null, error: err.message });
      } finally {
        try { await rpc("rm", { paths: [inP, outP] }); } catch (e) { /* ignore */ }
      }
    }
    if (cancelled) {
      writeReport(`Batch cancelled. Cleaned ${done.length}/${files.length}.`, true);
      await afterCancel(true); showResults(); return;
    }
    $("#busy-cancel").hidden = true;
    if (done.length > 1) {
      const zip = await makeZip(done);
      const zipName = "cleaned_pdfs.zip";
      el.outputs.insertBefore(zipRow(zip, zipName), el.outputs.firstChild);
    }
    state.batch = null;
    writeReport(`Batch complete. Successful: ${done.length}/${files.length}. Failed: ${fails}.`, true);
    setBusy(false, "Batch complete");
    toast(`Batch complete: ${done.length}/${files.length} cleaned`, fails > 0);
    showResults();
  });
  function zipRow(blob, name) {
    // reuse addOutput's markup, then move the new row to the top
    const before = el.outputs.children.length;
    addOutput({ name, blob, type: "application/zip" });
    state.outputs.pop();
    return el.outputs.children[before];
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
  const VIEWS = { home: $("#view-home"), upload: $("#view-upload"), settings: $("#view-settings") };
  const TITLES = { settings: "Settings", single: "Upload a PDF", batch: "Batch Upload" };
  const nav = { view: "home", mode: "single", subTitle: $("#sub-title") };
  function go(view, mode) {
    nav.view = view;
    if (mode) nav.mode = mode;
    Object.entries(VIEWS).forEach(([k, n]) => (n.hidden = k !== view));
    el.app.dataset.view = view;
    VIEWS.upload.dataset.mode = nav.mode;
    el.bar.dataset.mode = nav.mode;
    el.bar.hidden = view !== "upload" || nav.mode !== "batch" || !state.ready;
    el.btnBatch.classList.toggle("main", nav.mode === "batch");
    nav.subTitle.textContent = view === "settings" ? TITLES.settings : view === "upload" ? TITLES[nav.mode] : "";
    syncViewer();
    window.scrollTo(0, 0);
  }
  function syncViewer() {
    const on = nav.view === "upload" && nav.mode === "single" && !!state.file;
    VIEWS.upload.dataset.file = on ? "1" : "0";
    document.body.classList.toggle("viewer-open", on);
  }
  $("#m-upload").addEventListener("click", () => { go("upload", "single"); if (!state.busy) el.fileInput.click(); });
  $("#m-batch").addEventListener("click", () => go("upload", "batch"));
  $("#m-settings").addEventListener("click", () => go("settings"));
  $("#back-btn").addEventListener("click", () => go("home"));
  el.fileInput.addEventListener("cancel", () => { if (!state.file && nav.view === "upload" && nav.mode === "single") go("home"); });

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
  const look = { theme: "system", accent: 0 };
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
    m.hidden = false; document.body.classList.add("modal-open");
    (m.querySelector("[data-close]") || m).focus?.();
  }
  function closeModal(m) { if (m.hidden) return; m.hidden = true; m.dispatchEvent(new Event("modalclose")); if (!$(".modal:not([hidden])")) document.body.classList.remove("modal-open"); }
  $$(".modal").forEach((m) => m.addEventListener("click", (e) => { if (e.target === m || e.target.closest("[data-close]")) closeModal(m); }));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { const m = $(".modal:not([hidden])"); if (m) closeModal(m); } });
  $("#open-disclaimer").addEventListener("click", () => openModal("modal-disclaimer"));


  /* ------------------------------------------------------------------ *
   * Viewer: options sheet, analysis box, bubble, swipe                 *
   * ------------------------------------------------------------------ */
  $("#an-chips-slot").appendChild(el.chips);
  $("#v-analyze").addEventListener("click", () => el.btnAnalyze.click());
  $("#viewer-back").addEventListener("click", () => go("home"));
  $("#an-clean").addEventListener("click", () => { closeModal($("#modal-analysis")); openNameDialog("clean"); });
  $("#an-copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("#an-report").textContent); toast("Copied"); } catch (e) { toast("Couldn't copy", true); }
  });
  $("#opt-clean").addEventListener("click", () => { closeModal($("#modal-opts")); openNameDialog("clean"); });
  $("#opt-unlock").addEventListener("click", () => { closeModal($("#modal-opts")); openNameDialog("unlock"); });

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
      const h = host.getBoundingClientRect();
      const x = Math.min(h.width - b.offsetWidth - 6, Math.max(6, e.clientX - d.ox - h.left));
      const y = Math.min(h.height - b.offsetHeight - 6, Math.max(6, e.clientY - d.oy - h.top));
      Object.assign(b.style, { left: x + "px", top: y + "px", right: "auto", bottom: "auto" });
    });
    b.addEventListener("pointerup", () => { if (d && !moved && !b.disabled) openOptions(); d = null; });
    b.addEventListener("pointercancel", () => { d = null; });
    b.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openOptions(); } });
    window.addEventListener("resize", () => Object.assign(b.style, { left: "", top: "", right: "", bottom: "" }));
  })();

  (() => { // swipe left / right to change pages
    const box = $("#pagebox");
    let s0 = null, dx = 0;
    el.stage.addEventListener("pointerdown", (e) => {
      if (state.drawing || el.prevImg.hidden || e.target.closest(".vnav, .hf-handle")) return;
      s0 = { x: e.clientX }; dx = 0; box.style.transition = "none";
    });
    el.stage.addEventListener("pointermove", (e) => { if (!s0) return; dx = e.clientX - s0.x; box.style.transform = "translateX(" + dx * 0.6 + "px)"; });
    const end = () => {
      if (!s0) return;
      s0 = null; box.style.transition = ""; box.style.transform = "";
      if (dx < -70 && state.page < state.pages - 1) { state.page++; loadPreview(); }
      else if (dx > 70 && state.page > 0) { state.page--; loadPreview(); }
      dx = 0;
    };
    el.stage.addEventListener("pointerup", end);
    el.stage.addEventListener("pointercancel", end);
    document.addEventListener("keydown", (e) => {
      if (!document.body.classList.contains("viewer-open") || $(".modal:not([hidden])")) return;
      if (e.key === "ArrowRight") el.pgNext.click(); else if (e.key === "ArrowLeft") el.pgPrev.click();
    });
  })();


  /* Eraser menu: five options, each opens its own window */
  function refreshOptStates() {
    const n = (v) => parseFloat(String(v || "0").replace(",", ".")) || 0;
    const t = n(el.top.value), b = n(el.bottom.value);
    $("#o-hf-s").textContent = state.hf ? "Active. Tap for exact %" : t || b ? "Header " + t + "%, footer " + b + "%" : "Off";
    const a = parseRegionsLenient(el.regions.value).length;
    $("#draw-state").textContent = state.drawing ? "Drawing. Tap for areas" : a ? a + (a > 1 ? " areas" : " area") : "Off";
    const tx = [el.header, el.footer].filter((x) => x.value.trim()).length;
    $("#o-text-s").textContent = tx ? tx + " set" : "None";
    const wm = el.watermark.value.split(";").filter((x) => x.trim()).length + (el.xrefs.value.trim() ? 1 : 0) + (el.imgWm.checked ? 1 : 0);
    $("#o-wm-s").textContent = wm ? wm + " on" : "None";
    const ot = [el.meta, el.annots, el.links, el.extras, el.hidden].filter((x) => x.checked).length;
    $("#o-other-s").textContent = ot ? ot + " on" : "None";
  }
  function openOptions() { refreshOptStates(); openModal("modal-opts"); }
  const optsModal = $("#modal-opts");
  const viaMenu = (id, fn) => $("#" + id).addEventListener("click", () => { closeModal(optsModal); fn(); });
  viaMenu("o-hf", () => { if (state.hf) openModal("modal-hf"); else setTool("hf"); });
  el.draw.addEventListener("click", () => { closeModal(optsModal); if (state.drawing || el.regions.value.trim()) openModal("modal-areas"); else setTool("draw"); });
  viaMenu("o-text", () => openModal("modal-text"));
  viaMenu("o-wm", () => openModal("modal-wm"));
  viaMenu("o-other", () => openModal("modal-other"));
  $("#hf-hide").addEventListener("click", () => { setTool(null); closeModal($("#modal-hf")); });
  $("#ar-draw").addEventListener("click", () => { closeModal($("#modal-areas")); setTool("draw"); });
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
    startWorker();
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
    state.cancelled = false;
    setBusy(false, "Cancelled");
    if (keepBatch) { toast("Cancelled"); return; }
    Object.assign(state, { file: null, inPath: null, cleanPath: null, cleanName: null, locked: false, pages: 0 });
    el.password.value = ""; el.prevImg.hidden = true; setTool(null); syncViewer(); go("home");
    toast("Cancelled. Choose the PDF again to retry.");
  }

  /* Android back button (called from native) */
  window.__onBack = () => {
    if (state.busy) return true;
    const m = $(".modal:not([hidden])");
    if (m) { closeModal(m); return true; }
    if (state.drawing || state.hf) { setTool(null); return true; }
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
