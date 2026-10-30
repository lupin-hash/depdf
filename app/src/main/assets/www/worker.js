/* Engine worker: runs the original DePDF Python code (PyMuPDF) via Pyodide/WebAssembly.
   Everything happens inside this worker, on the device. Nothing is uploaded. */
"use strict";

const BASE = new URL("./", self.location).href;
importScripts(BASE + "vendor/pyodide/pyodide.js");

let py = null;     // Pyodide instance
let eng = null;    // imported pdf_engine module

const post = (msg, transfer) => self.postMessage(msg, transfer || []);

async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Could not load " + url + " (" + res.status + ")");
  const total = Number(res.headers.get("content-length")) || 0;
  if (!res.body || !total) {
    const buf = new Uint8Array(await res.arrayBuffer());
    onProgress(buf.length, buf.length);
    return buf;
  }
  const reader = res.body.getReader();
  const out = new Uint8Array(total);
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.set(value, got);
    got += value.length;
    onProgress(got, total);
  }
  return got === total ? out : out.subarray(0, got);
}

async function init() {
  post({ type: "boot", stage: "Loading runtime…", pct: 2 });
  py = await loadPyodide({ indexURL: BASE + "vendor/pyodide/" });
  post({ type: "boot", stage: "Loading PDF engine…", pct: 25 });
  const wheel = await fetchWithProgress(BASE + "vendor/pymupdf.whl", (a, b) =>
    post({ type: "boot", stage: "Loading PDF engine…", pct: 25 + Math.round((a / b) * 60) })
  );
  post({ type: "boot", stage: "Starting…", pct: 90 });
  const site = py.runPython("import sysconfig; sysconfig.get_path('purelib')");
  py.unpackArchive(wheel, "wheel", { extractDir: site });
  py.FS.mkdirTree("/eng");
  py.FS.mkdirTree("/in");
  py.FS.mkdirTree("/out");
  const src = await (await fetch(BASE + "engine/pdf_engine.py")).text();
  py.FS.writeFile("/eng/pdf_engine.py", src);
  py.runPython("import sys; sys.path.insert(0, '/eng')");
  eng = py.pyimport("pdf_engine");
  const ver = py.runPython("import pymupdf; pymupdf.__version__");
  post({ type: "boot", stage: "Ready", pct: 100 });
  return { version: ver };
}

function ensureDir(path) {
  const dir = path.substring(0, path.lastIndexOf("/"));
  if (dir) py.FS.mkdirTree(dir);
}

const handlers = {
  async init() {
    return await init();
  },
  put({ path, buffer }) {
    eng.close_preview_cache();
    ensureDir(path);
    py.FS.writeFile(path, new Uint8Array(buffer));
    return {};
  },
  get({ path }) {
    const data = py.FS.readFile(path);
    // copy so the buffer can be transferred
    const copy = new Uint8Array(data.length);
    copy.set(data);
    return { __transfer: [copy.buffer], buffer: copy.buffer };
  },
  rm({ paths }) {
    eng.close_preview_cache();
    for (const p of paths) {
      try { py.FS.unlink(p); } catch (e) { /* already gone */ }
    }
    return {};
  },
  protected({ path }) {
    return { protected: !!eng.is_protected(path) };
  },
  preview({ path, password, page, zoom }) {
    const res = eng.preview_pdf(path, password || "", page || 0, zoom || 1.4);
    const js = res.toJs({ dict_converter: Object.fromEntries });
    res.destroy();
    const png = js.png instanceof Uint8Array ? js.png : new Uint8Array(js.png);
    const copy = new Uint8Array(png.length);
    copy.set(png);
    return { __transfer: [copy.buffer], png: copy.buffer, pages: js.pages, page: js.page, w: js.w, h: js.h };
  },
  words({ path, password, page }) {
    return { json: eng.page_text_lines(path, password || "", page || 0) };
  },
  job({ job }) {
    eng.close_preview_cache();
    const out = eng.run_job(JSON.stringify(job));
    return JSON.parse(out);
  },
};

self.onmessage = async (ev) => {
  const { id, cmd } = ev.data;
  try {
    const fn = handlers[cmd];
    if (!fn) throw new Error("Unknown command " + cmd);
    const res = (await fn(ev.data)) || {};
    const transfer = res.__transfer || [];
    delete res.__transfer;
    post({ id, ok: true, ...res }, transfer);
  } catch (err) {
    let message = err && err.message ? String(err.message) : String(err);
    // Python exceptions: keep only the final line ("RuntimeError: …" -> message)
    if (err && err.type) {
      const lines = message.trim().split("\n");
      message = lines[lines.length - 1].replace(/^[A-Za-z]*(Error|Exception): /, "");
    }
    post({ id, ok: false, error: message });
  }
};
