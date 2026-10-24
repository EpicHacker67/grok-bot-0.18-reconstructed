export const SAND_BROWSER_DRIVER_VERSION = 3;
export const SAND_BROWSER_DRIVER_BOX_DIR = "/tmp/.sand-browser";
export const SAND_BROWSER_DRIVER_BOX_PATH = SAND_BROWSER_DRIVER_BOX_DIR + "/driver-v" + String(SAND_BROWSER_DRIVER_VERSION) + ".mjs";
export const SAND_BROWSER_RESULT_MARKER = "__SAND_BROWSER_RESULT__";
export const SAND_BROWSER_DRIVER_SOURCE = `
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";

const RESULT_MARKER = "__SAND_BROWSER_RESULT__";
const STATE_DIR = "/tmp/.sand-browser";
const ACTION_TIMEOUT_MS = 10000;
const NAVIGATE_TIMEOUT_MS = 25000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function statePath(display) {
  return STATE_DIR + "/views-" + String(display) + ".json";
}

function loadState(display) {
  try {
    const parsed = JSON.parse(readFileSync(statePath(display), "utf8"));
    if (parsed && typeof parsed === "object") {
      return {
        views: parsed.views && typeof parsed.views === "object" ? parsed.views : {},
        urls: parsed.urls && typeof parsed.urls === "object" ? parsed.urls : {},
        lastViewId: typeof parsed.lastViewId === "string" ? parsed.lastViewId : undefined,
      };
    }
  } catch {}
  return { views: {}, urls: {}, lastViewId: undefined };
}

function saveState(display, state) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const current = loadState(display);
    const views = { ...current.views, ...state.views };
    const urls = { ...current.urls, ...state.urls };
    for (const removed of state.deletedViews ?? []) {
      delete views[removed];
      delete urls[removed];
    }
    let lastViewId = state.lastViewId ?? current.lastViewId;
    if (lastViewId !== undefined && (state.deletedViews ?? []).includes(lastViewId)) {
      lastViewId = undefined;
    }
    const merged = { views, urls, lastViewId };
    const tmp = statePath(display) + "." + String(process.pid) + ".tmp";
    writeFileSync(tmp, JSON.stringify(merged));
    renameSync(tmp, statePath(display));
  } catch {}
}

// Serializes cross-process claims on a live tab: two concurrent driver calls
// (same-step parallel browser tools) re-adopting by URL could otherwise pick
// the SAME tab for different views before either saves. The winner writes its
// claim to the state file INSIDE the lock, so the loser's fresh read inside
// its own turn sees the tab as taken. A lock older than 5s is treated as
// leaked by a crashed driver and broken. Failure to lock degrades to the
// unlocked behavior instead of failing the op.
async function withViewClaimLock(display, fn) {
  const lockPath = statePath(display) + ".lock";
  const deadline = Date.now() + 3000;
  let locked = false;
  while (!locked && Date.now() < deadline) {
    try {
      mkdirSync(STATE_DIR, { recursive: true });
      writeFileSync(lockPath, String(process.pid), { flag: "wx" });
      locked = true;
    } catch {
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 5000) unlinkSync(lockPath);
      } catch {}
      await sleep(50);
    }
  }
  try {
    return await fn();
  } finally {
    if (locked) {
      try {
        unlinkSync(lockPath);
      } catch {}
    }
  }
}

async function cdpAlive(port) {
  try {
    const res = await fetch("http://127.0.0.1:" + String(port) + "/json/version", {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureChrome(port, display) {
  if (await cdpAlive(port)) return;
  const child = spawn("box-chrome", ["--new-window"], {
    env: { ...process.env, DISPLAY: ":" + String(display) }, stdio: "ignore",
  });
  child.on("error", () => {});
  child.unref();
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await cdpAlive(port)) return;
    await sleep(500);
  }
  throw new Error(
    "The box browser's CDP endpoint did not come up on port " + String(port)
  );
}

// A minimal raw CDP socket for the pre-connect probe below. Uses the box
// image's playwright-core bundled ws client (the driver already depends on
// playwright-core, and the box's plain node has no global WebSocket). Every
// send resolves with the response message, or undefined on timeout/failure \u2014
// never rejects and never hangs.
async function openCdpSocket(wsUrl) {
  let WS;
  try {
    const { createRequire } = await import("node:module");
    WS = createRequire(import.meta.url)("playwright-core/lib/utilsBundle").ws;
  } catch {
    return undefined;
  }
  let ws;
  try {
    ws = new WS(wsUrl);
  } catch {
    return undefined;
  }
  const opened = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 3000);
    ws.on("open", () => {
      clearTimeout(timer);
      resolve(true);
    });
    ws.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
  if (!opened) {
    try {
      ws.close();
    } catch {}
    return undefined;
  }
  let nextId = 1;
  const pending = new Map();
  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const send = (method, params, sessionId, timeoutMs) =>
    new Promise((resolve) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve(undefined);
      }, timeoutMs);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      const payload = { id, method, params: params !== undefined ? params : {} };
      if (sessionId !== undefined) payload.sessionId = sessionId;
      try {
        ws.send(JSON.stringify(payload));
      } catch {
        clearTimeout(timer);
        pending.delete(id);
        resolve(undefined);
      }
    });
  return {
    send,
    close: () => {
      try {
        ws.close();
      } catch {}
    },
  };
}

// A discarded tab (Memory Saver, or any lifecycle discard) keeps a page target
// in the target list but has no renderer, so attaching to it never completes.
// playwright's connectOverCDP auto-attaches to EVERY page, so one discarded
// tab hangs the whole connect and every driver call fails until something
// revives that tab. Before connecting, probe each page target over a raw CDP
// socket and activate the unresponsive ones \u2014 Chrome reloads a discarded tab
// when it becomes active \u2014 then hand focus back to the tab that was visible.
// A live-but-busy page that misses the probe deadline is also activated; that
// is harmless (activation does not reload a live tab, and focus is restored).
// Best-effort throughout: on any failure the plain connect proceeds and
// reports its own error.
async function reviveDiscardedTabs(port) {
  let socket;
  try {
    const base = "http://127.0.0.1:" + String(port);
    const listRes = await fetch(base + "/json/list", { signal: AbortSignal.timeout(1500) });
    if (!listRes.ok) return;
    const targets = (await listRes.json()).filter((t) => t.type === "page");
    if (targets.length === 0) return;
    const versionRes = await fetch(base + "/json/version", { signal: AbortSignal.timeout(1500) });
    if (!versionRes.ok) return;
    const wsUrl = (await versionRes.json()).webSocketDebuggerUrl;
    if (typeof wsUrl !== "string" || wsUrl.length === 0) return;
    socket = await openCdpSocket(wsUrl);
    if (socket === undefined) return;
    // Resolves to the page's visibilityState, or undefined when the page never
    // answers (a discarded tab's renderer is gone, so evaluate never returns).
    const probe = async (targetId) => {
      const attached = await socket.send(
        "Target.attachToTarget",
        { targetId, flatten: true },
        undefined,
        2000
      );
      const sessionId =
        attached !== undefined && attached.result !== undefined
          ? attached.result.sessionId
          : undefined;
      if (sessionId === undefined) return undefined;
      const evaluated = await socket.send(
        "Runtime.evaluate",
        { expression: "document.visibilityState", returnByValue: true },
        sessionId,
        1500
      );
      socket.send("Target.detachFromTarget", { sessionId }, undefined, 1000);
      if (evaluated === undefined || evaluated.result === undefined) return undefined;
      return evaluated.result.result !== undefined ? evaluated.result.result.value : undefined;
    };
    const states = await Promise.all(targets.map((t) => probe(t.id)));
    const hung = targets.filter((t, i) => states[i] === undefined);
    if (hung.length === 0) return;
    const visible = targets.find((t, i) => states[i] === "visible");
    // Revive every hung tab under ONE overall deadline, never a per-tab
    // budget: a long-lived box can hold many discarded tabs at once, and
    // sequential per-tab waits would eat the driver's 90s watchdog before the
    // connect even starts. The activation ack is milliseconds and a discarded
    // tab keeps reloading after focus moves on, so each round activates all
    // stragglers in parallel, then probes them in parallel, until every tab
    // answers or the deadline passes.
    const deadline = Date.now() + 20000;
    let remaining = hung.map((t) => t.id);
    while (remaining.length > 0 && Date.now() < deadline) {
      await Promise.all(
        remaining.map((id) =>
          socket.send("Target.activateTarget", { targetId: id }, undefined, 2000)
        )
      );
      const results = await Promise.all(remaining.map((id) => probe(id)));
      remaining = remaining.filter((_, i) => results[i] === undefined);
      if (remaining.length > 0) await sleep(300);
    }
    if (visible !== undefined) {
      await socket.send("Target.activateTarget", { targetId: visible.id }, undefined, 2000);
    }
  } catch {
  } finally {
    if (socket !== undefined) socket.close();
  }
}

// Connect Playwright only to the requested page. Its normal browser-wide
// auto-attach waits for *every* tab to initialize, including frozen renderers.
// The loopback relay replaces root auto-attach with one explicit attachment;
// child-frame auto-attach still works. It never reloads or activates other tabs.
async function scopedBrowserConnection(port, targetId) {
  const { createRequire } = await import("node:module");
  const { ws: WS, wsServer: WSS } = createRequire(import.meta.url)("playwright-core/lib/utilsBundle");
  const version = await fetch("http://127.0.0.1:" + port + "/json/version", { signal: AbortSignal.timeout(3000) }).then(r => r.json());
  const server = new WSS({ host: "127.0.0.1", port: 0, path: "/" + crypto.randomUUID() });
  await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  const sockets = new Set();
  server.on("connection", client => {
    const upstream = new WS(version.webSocketDebuggerUrl);
    sockets.add(client); sockets.add(upstream);
    let nextId = -1;
    const pending = new Map(), attached = new Set();
    const opened = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Browser connection did not open")), 3000);
      upstream.once("open", () => { clearTimeout(timer); resolve(); });
      upstream.once("error", error => { clearTimeout(timer); reject(error); });
      upstream.once("close", () => { clearTimeout(timer); reject(new Error("Browser connection closed")); });
    });
    void opened.catch(() => client.close());
    const send = async (method, params) => {
      await opened;
      return new Promise((resolve, reject) => {
        const id = nextId--;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error("Browser connection command timed out: " + method)); }, 5000);
        pending.set(id, { resolve, reject, timer });
        upstream.send(JSON.stringify({ id, method, params }));
      });
    };
    const attach = async id => {
      if (!id || attached.has(id)) return;
      attached.add(id);
      const response = await send("Target.attachToTarget", { targetId: id, flatten: true });
      if (response.error) { attached.delete(id); throw new Error(response.error.message); }
    };
    const stop = () => {
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("Browser connection closed")); }
      pending.clear();
      client.terminate(); upstream.terminate();
      sockets.delete(client); sockets.delete(upstream);
    };
    client.once("close", stop); upstream.once("close", stop);
    client.on("error", () => {}); upstream.on("error", () => {});
    upstream.on("message", data => {
      const message = JSON.parse(String(data));
      const entry = pending.get(message.id);
      if (entry) { clearTimeout(entry.timer); pending.delete(message.id); entry.resolve(message); }
      else if (client.readyState === WS.OPEN) client.send(String(data));
    });
    client.on("message", async data => {
      let message;
      try {
        message = JSON.parse(String(data));
        await opened;
        if (!message.sessionId && message.method === "Target.setAutoAttach") {
          if (message.params.autoAttach) await attach(targetId);
          client.send(JSON.stringify({ id: message.id, result: {} }));
        } else if (!message.sessionId && message.method === "Target.createTarget") {
          const response = await send(message.method, message.params);
          if (response.result?.targetId) await attach(response.result.targetId);
          client.send(JSON.stringify({ ...response, id: message.id }));
        } else upstream.send(String(data));
      } catch (error) {
        if (client.readyState === WS.OPEN) client.send(JSON.stringify({ id: message?.id, error: { code: -32000, message: String(error.message ?? error) } }));
      }
    });
  });
  return {
    endpoint: "ws://127.0.0.1:" + server.address().port + server.options.path,
    close: async () => { for (const socket of sockets) socket.terminate(); await new Promise(resolve => server.close(resolve)); },
  };
}

async function routedTarget(request, state) {
  const base = "http://127.0.0.1:" + request.cdpPort;
  const targets = await fetch(base + "/json/list", { signal: AbortSignal.timeout(3000) }).then(r => r.json()).then(rows => rows.filter(t => t.type === "page"));
  const entries = targets.map((target, index) => {
    const viewId = Object.keys(state.views).find(key => key !== "default" && state.views[key] === target.id) ?? "tab-" + target.id;
    state.views[viewId] = target.id; state.urls[viewId] = target.url;
    return { index, viewId, url: target.url, title: target.title };
  });
  saveState(request.display, state);
  if (request.op === "tabs" && request.action === "list") return { result: { ok: true, summary: "Listed " + entries.length + " tab(s)", data: JSON.stringify(entries, null, 1) } };
  if ((request.op === "navigate" && request.newTab) || (request.op === "tabs" && request.action === "new")) return {};
  if (request.op === "tabs" && Number.isInteger(request.index)) {
    const entry = entries[request.index];
    if (!entry) throw new Error("No tab at that index. Refresh browser_tabs.");
    request.viewId = entry.viewId; delete request.index;
  }
  let target = typeof request.viewId === "string" ? targets.find(t => t.id === state.views[request.viewId]) : undefined;
  if (request.viewId && !target) throw new Error("This tab is no longer available. Refresh browser_tabs; no other tab was changed.");
  const version = await fetch(base + "/json/version", { signal: AbortSignal.timeout(3000) }).then(r => r.json());
  const socket = await openCdpSocket(version.webSocketDebuggerUrl);
  if (!socket) throw new Error("Cannot connect to Chrome's control endpoint. No page action was attempted.");
  try {
    if (!target) {
      const states = await Promise.all(targets.map(async tab => {
        const attached = await socket.send("Target.attachToTarget", { targetId: tab.id, flatten: true }, undefined, 1000);
        const sessionId = attached?.result?.sessionId;
        if (!sessionId) return undefined;
        try {
          const state = await socket.send("Runtime.evaluate", { expression: "document.visibilityState", returnByValue: true }, sessionId, 1000);
          return state?.result?.result?.value;
        } finally { await socket.send("Target.detachFromTarget", { sessionId }, undefined, 500); }
      }));
      target = targets.find((_, i) => states[i] === "visible");
      if (!target) throw new Error("The visible tab is not responding. Use browser_tabs and an explicit viewId; no other tab was changed.");
      request.viewId = entries.find(entry => state.views[entry.viewId] === target.id).viewId;
    }
    if (request.op === "tabs" && request.action === "close") {
      const closed = await socket.send("Target.closeTarget", { targetId: target.id }, undefined, 3000);
      if (!closed?.result?.success) throw new Error("Tab close was not confirmed. Refresh browser_tabs before retrying.");
      const deletedViews = Object.keys(state.views).filter(key => state.views[key] === target.id);
      saveState(request.display, { views: {}, urls: {}, deletedViews });
      return { result: { ok: true, summary: "Closed selected tab" } };
    }
    // Only an explicit selection activates a discarded tab. Never revive every
    // background tab just to read an unrelated working page.
    if (request.op === "tabs" && request.action === "select") await socket.send("Target.activateTarget", { targetId: target.id }, undefined, 2000);
    return { targetId: target.id };
  } finally { socket.close(); }
}

function bounded(promise, milliseconds, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + " did not respond")), milliseconds); })]).finally(() => clearTimeout(timer));
}

async function targetIdOf(context, page) {
  const session = await context.newCDPSession(page);
  try {
    const info = await session.send("Target.getTargetInfo");
    return info.targetInfo.targetId;
  } finally {
    await session.detach().catch(() => {});
  }
}

async function pagesByTargetId(context) {
  const byTarget = new Map();
  for (const p of context.pages().filter((page) => !page.isClosed())) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        byTarget.set(await targetIdOf(context, p), p);
        break;
      } catch {
        await sleep(150);
      }
    }
  }
  return byTarget;
}

async function resolvePage(request, context, state) {
  const explicit = typeof request.viewId === "string" && request.viewId.length > 0;
  let viewId = explicit ? request.viewId : state.lastViewId ?? "default";
  const mappedTarget = state.views[viewId];
  let byTarget = await pagesByTargetId(context);
  let page = mappedTarget !== undefined ? byTarget.get(mappedTarget) : undefined;
  if (page === undefined && mappedTarget !== undefined && request.strictView !== true) {
    const deadline = Date.now() + 5000;
    while (page === undefined && Date.now() < deadline) {
      await sleep(400);
      byTarget = await pagesByTargetId(context);
      page = byTarget.get(mappedTarget);
    }
  }
  // Discarding a tab destroys its target and revives it under a NEW targetId
  // with the same URL, so a mapped target that never comes back usually means
  // the view's tab was discarded (Memory Saver), not closed. Re-adopt the tab
  // by its last recorded URL instead of falling through to a blank new tab \u2014
  // only a tab no other view claims, so two same-URL views cannot collapse.
  if (page === undefined && mappedTarget !== undefined && request.strictView !== true) {
    const lastUrl = state.urls !== undefined ? state.urls[viewId] : undefined;
    if (typeof lastUrl === "string" && lastUrl.length > 0 && lastUrl !== "about:blank") {
      await withViewClaimLock(request.display, async () => {
        // Re-read the persisted views inside the lock: a concurrent driver
        // process may have claimed a candidate after this one loaded state.
        const persisted = loadState(request.display);
        const claimed = new Set([
          ...Object.values(state.views),
          ...Object.values(persisted.views),
        ]);
        for (const [candidateId, candidate] of byTarget) {
          if (candidate.url() === lastUrl && !claimed.has(candidateId)) {
            page = candidate;
            state.views[viewId] = candidateId;
            saveState(request.display, { views: { [viewId]: candidateId } });
            break;
          }
        }
      });
    }
  }
  if (page === undefined && request.strictView === true && explicit) {
    throw new Error("This tab is no longer available. Use browser_tabs to select an existing tab.");
  }
  if (request.preferVisible === true && !explicit) {
    for (const [targetId, candidate] of byTarget) {
      if (await bounded(candidate.evaluate(() => document.visibilityState === "visible"), 1000, "Tab visibility").catch(() => false)) {
        page = candidate;
        viewId = Object.keys(state.views).find(key => key !== "default" && state.views[key] === targetId) ?? "tab-" + targetId;
        break;
      }
    }
  }
  if (page === undefined && !explicit && byTarget.size > 0) {
    const pages = [...byTarget.values()];
    page = pages[pages.length - 1];
  }
  if (page === undefined) {
    page = await context.newPage();
  }
  state.views[viewId] = await targetIdOf(context, page);
  state.lastViewId = viewId;
  page.setDefaultTimeout(ACTION_TIMEOUT_MS);
  return { page, viewId };
}

async function refHandle(page, ref) {
  // Element handles stay scoped to their document, including embedded frames.
  // A snapshot refresh invalidates every document's refs together.
  for (const frame of page.frames().slice(0, 12)) {
    let handle;
    try {
      handle = await bounded(frame.evaluateHandle((r) => {
        const map = globalThis.__sandRefs;
        const element = map instanceof Map ? map.get(r) : undefined;
        return element?.isConnected ? element : undefined;
      }, ref), 1500, "Element lookup");
      const element = handle.asElement();
      if (element !== null) return element;
    } catch {}
    await bounded(Promise.resolve(handle?.dispose()), 500, "Element cleanup").catch(() => {});
  }
  throw new Error("Unknown or stale ref " + JSON.stringify(ref) + ". Take a fresh browser_snapshot and use a ref from it.");
}

const SNAPSHOT_FN = (opts) => {
  const doc = globalThis.document;
  const win = globalThis.window;
  const root = opts.selector ? doc.querySelector(opts.selector) : doc.body;
  const refs = new Map();
  const generation = Array.from(crypto.getRandomValues(new Uint32Array(2)), n => n.toString(36)).join("-");
  globalThis.__sandRefs = refs;
  if (!root) return { lines: ["(no matching element for selector)"], refCount: 0 };
  let refCounter = 0;
  const lines = [];
  let textRemaining = 1600;
  let omittedText = false;
  const maxNodes = opts.maxNodes ?? 400;
  let nodeCount = 0;
  const interactiveMatcher =
    "a[href], button, input, select, textarea, summary, " +
    '[role="button"], [role="link"], [role="checkbox"], [role="radio"], ' +
    '[role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="combobox"], ' +
    '[role="option"], [role="switch"], [role="searchbox"], [role="textbox"], ' +
    '[role="slider"], [contenteditable="true"], [onclick]';
  const isVisible = (el) => {
    if (el.getAttribute("aria-hidden") === "true") return false;
    const style = win.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = el.getBoundingClientRect();
    return (rect.width > 0 && rect.height > 0) || style.display === "contents";
  };
  const trim = (text, max) => {
    const t = (text ?? "").replace(/\\s+/g, " ").trim();
    return t.length > max ? t.slice(0, max) + "\u2026" : t;
  };
  const nameOf = (el) => {
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const label = labelledBy.split(/\\s+/).map(id => doc.getElementById(id)?.innerText ?? "").join(" ").trim();
      if (label) return trim(label, 160);
    }
    const aria = el.getAttribute("aria-label");
    if (aria) return trim(aria, 80);
    if (el.labels && el.labels.length > 0) return trim(el.labels[0].innerText, 80);
    const placeholder = el.getAttribute("placeholder");
    if (placeholder) return trim(placeholder, 80);
    const alt = el.getAttribute("alt");
    if (alt) return trim(alt, 80);
    const title = el.getAttribute("title");
    if (title) return trim(title, 80);
    return trim(el.innerText ?? el.value ?? "", 80);
  };
  const roleOf = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const type = (el.getAttribute("type") ?? "text").toLowerCase();
      if (type === "button" || type === "submit" || type === "reset") return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      return "textbox";
    }
    if (/^h[1-6]$/.test(tag)) return "heading";
    return tag;
  };
  const describe = (el, depth) => {
    const role = roleOf(el);
    const name = el.matches(interactiveMatcher) ? nameOf(el) : trim(el.innerText, opts.compact ? 160 : 600);
    const disabled = el.disabled || el.getAttribute("aria-disabled") === "true";
    let line = "  ".repeat(Math.min(depth, 6)) + "- " + role;
    if (name) line += " " + JSON.stringify(name);
    if (el.matches(interactiveMatcher) && !disabled) {
      refCounter += 1;
      const ref = "e" + generation + "-" + String(refCounter);
      refs.set(ref, el);
      line += " [ref=" + ref + "]";
    }
    if (disabled) line += " disabled";
    if (el.checked === true || el.getAttribute("aria-checked") === "true") line += " checked";
    if (el.getAttribute("aria-expanded") !== null) line += " expanded=" + el.getAttribute("aria-expanded");
    const tag = el.tagName.toLowerCase();
    if ((tag === "input" || tag === "textarea") && typeof el.value === "string" && el.value.length > 0) {
      const inputType = (el.getAttribute("type") ?? "").toLowerCase();
      const isSecret = inputType === "password" || el.getAttribute("autocomplete") === "current-password" || el.getAttribute("autocomplete") === "new-password";
      line += " value=" + (isSecret ? '"<redacted>"' : JSON.stringify(trim(el.value, 40)));
    }
    if (tag === "select" && opts.compact) {
      line += " selected=" + JSON.stringify(Array.from(el.selectedOptions ?? [], option => option.value));
      line += " options=" + JSON.stringify(Array.from(el.options ?? []).slice(0, 20).map(option => ({ value: option.value, label: trim(option.label, 60), disabled: option.disabled })));
      if (el.options?.length > 20) line += " (more options omitted)";
    }
    if (tag === "a") {
      const href = el.getAttribute("href");
      if (href && !href.startsWith("javascript:")) line += " href=" + JSON.stringify(trim(href, 80));
    }
    return line;
  };
  const walk = (el, depth) => {
    if (nodeCount >= maxNodes || depth > (opts.maxDepth ?? 20)) return;
    if (!(el instanceof win.HTMLElement)) return;
    const tag = el.tagName.toLowerCase();
    if (tag === "script" || tag === "style" || tag === "noscript") return;
    if (!isVisible(el)) return;
    const isInteractive = el.matches(interactiveMatcher);
    const isHeading = /^h[1-6]$/.test(tag);
    const isStatus = opts.compact && (el.getAttribute("role") === "status" || el.getAttribute("role") === "alert" || ["polite", "assertive"].includes(el.getAttribute("aria-live")));
    const isTextual = !opts.interactive && (tag === "p" || tag === "li" || tag === "label" || tag === "td" || tag === "th");
    let childDepth = depth;
    if (isInteractive || isHeading || isStatus || (isTextual && trim(el.innerText, 10).length > 0 && el.querySelector(interactiveMatcher) === null)) {
      if (opts.compact && isTextual && !isInteractive && !isHeading && !isStatus) {
        const length = trim(el.innerText, 160).length;
        if (length > textRemaining) { omittedText = true; return; }
        textRemaining -= length;
        if (trim(el.innerText, 100000).length > 160) omittedText = true;
      }
      nodeCount += 1;
      lines.push(describe(el, depth));
      childDepth = depth + 1;
      if (isInteractive || (isTextual && !isStatus)) return;
    }
    for (const child of el.children) walk(child, childDepth);
    if (el.shadowRoot) for (const child of el.shadowRoot.children) walk(child, childDepth);
  };
  walk(root, 0);
  if (nodeCount >= maxNodes) lines.push("(snapshot truncated at " + String(maxNodes) + " elements)");
  if (omittedText) lines.push("(Page text abbreviated; use browser_read to find or read complete passages.)");
  return { lines, refCount: refCounter };
};

async function visiblePageFrames(page) {
  const frames = page.frames().slice(0, 12);
  const visibility = await Promise.all(frames.map(async frame => {
    if (frame === page.mainFrame()) return true;
    let element;
    try {
      element = await bounded(frame.frameElement(), 1000, "Frame element");
      return await bounded(element.isVisible(), 1000, "Frame visibility");
    } catch { return false; }
    finally { await bounded(Promise.resolve(element?.dispose()), 500, "Frame cleanup").catch(() => {}); }
  }));
  return frames.filter((_, i) => visibility[i]);
}

async function snapshotPage(page, options = {}) {
  const frames = page.frames();
  await Promise.all(frames.map(frame => bounded(frame.evaluate(() => { globalThis.__sandRefs = new Map(); }), 1500, "Frame refs").catch(() => {})));
  const visible = await visiblePageFrames(page);
  const snapshots = await Promise.all(visible.map(async (frame, index) => {
    try {
      const snapshot = await bounded(frame.evaluate(SNAPSHOT_FN, { ...options, maxNodes: index === 0 ? 300 : 80 }), index === 0 ? 5000 : 1500, "Page snapshot");
      return { lines: index > 0 ? ["Embedded frame: " + frame.url(), ...snapshot.lines] : snapshot.lines, refCount: snapshot.refCount };
    } catch (error) {
      if (index === 0) throw error;
      return { lines: ["(frame changed or is unavailable; refresh if needed)"], refCount: 0 };
    }
  }));
  const lines = snapshots.flatMap(snapshot => snapshot.lines);
  if (frames.length > 12) lines.push("(additional frames omitted; use a screenshot to inspect them)");
  return { lines, refCount: snapshots.reduce((total, snapshot) => total + snapshot.refCount, 0) };
}

const READ_PAGE_FN = ({ selector }) => {
  const element = selector ? document.querySelector(selector) : document.querySelector('main, article, [role="main"]') ?? document.body;
  return element ? element.innerText : "(no matching element)";
};

function clickOptionsFor(args) {
  const options = { timeout: ACTION_TIMEOUT_MS };
  if (args.button === "right" || args.button === "middle") options.button = args.button;
  if (Array.isArray(args.modifiers) && args.modifiers.length > 0) options.modifiers = args.modifiers;
  if (typeof args.holdDurationMs === "number" && args.holdDurationMs > 0) options.delay = Math.min(args.holdDurationMs, 5000);
  if (args.doubleClick === true) options.clickCount = 2;
  return options;
}

const OPS = {
  navigate: async ({ request, context, state }) => {
    if (request.newTab === true) {
      const page = await context.newPage();
      const viewId = typeof request.viewId === "string" && request.viewId.length > 0 ? request.viewId : "tab-" + String(Date.now());
      state.views[viewId] = await targetIdOf(context, page);
      state.lastViewId = viewId;
      page.setDefaultTimeout(ACTION_TIMEOUT_MS);
      await page.goto(request.url, { waitUntil: "domcontentloaded", timeout: NAVIGATE_TIMEOUT_MS });
      if (!request.snapshotAfter) await page.waitForLoadState("load", { timeout: 5000 }).catch(() => {});
      return { page, viewId, summary: "Opened " + request.url + " in a new tab" };
    }
    const { page, viewId } = await resolvePage(request, context, state);
    await page.goto(request.url, { waitUntil: "domcontentloaded", timeout: NAVIGATE_TIMEOUT_MS });
    if (!request.snapshotAfter) await page.waitForLoadState("load", { timeout: 5000 }).catch(() => {});
    return { page, viewId, summary: "Navigated to " + request.url };
  },
  snapshot: async ({ request, context, state }) => {
    const { page, viewId } = await resolvePage(request, context, state);
    const result = await snapshotPage(page, {
      compact: request.compact === true,
      interactive: request.interactive === true,
      maxDepth: typeof request.maxDepth === "number" ? request.maxDepth : 20,
      selector: typeof request.selector === "string" && request.selector.length > 0 ? request.selector : undefined,
    });
    const data = result.lines.join("\\n");
    return {
      page,
      viewId,
      summary: "Captured page snapshot (" + String(result.refCount) + " interactive refs)",
      data,
    };
  },
  read: async ({ request, context, state }) => {
    const { page, viewId } = await resolvePage(request, context, state);
    const chunks = [];
    for (const [index, frame] of (await visiblePageFrames(page)).slice(0, 12).entries()) {
      try {
        const text = await frame.evaluate(READ_PAGE_FN, { selector: request.selector });
        if (text) chunks.push((index ? "Embedded frame: " + frame.url() + "\\n" : "") + text);
      } catch { chunks.push("(frame unavailable)"); }
    }
    const text = chunks.join("\\n\\n");
    const limit = Math.min(request.limit ?? 12000, 24000);
    let start = Math.min(request.start ?? 0, text.length);
    if (typeof request.find === "string") {
      const found = text.toLocaleLowerCase().indexOf(request.find.toLocaleLowerCase(), start);
      if (found < 0) return { page, viewId, summary: "Text not found in the currently rendered page", data: "No match for " + JSON.stringify(request.find) };
      start = Math.max(0, found - Math.min(500, Math.floor(limit / 4)));
    }
    const end = Math.min(text.length, start + limit);
    return { page, viewId, summary: "Read rendered text (characters " + start + "–" + end + " of " + text.length + ")", data: text.slice(start, end) + (end < text.length ? "\\n[More text: call browser_read with start=" + end + "]" : "") };
  },
  wait: async ({ request, context, state }) => {
    const { page, viewId } = await resolvePage(request, context, state);
    await page.getByText(request.text, { exact: false }).first().waitFor({ state: request.state ?? "visible", timeout: request.timeoutMs ?? 8000 });
    return { page, viewId, summary: "Text is " + (request.state ?? "visible") + ": " + request.text };
  },
  history: async ({ request, context, state }) => {
    const { page, viewId } = await resolvePage(request, context, state);
    const options = { waitUntil: "domcontentloaded", timeout: NAVIGATE_TIMEOUT_MS };
    if (request.action === "back") await page.goBack(options);
    else if (request.action === "forward") await page.goForward(options);
    else if (request.action === "reload") await page.reload(options);
    else throw new Error("Unknown history action");
    return { page, viewId, summary: "History: " + request.action };
  },
  click: async ({ request, context, state }) => {
    const { page, viewId } = await resolvePage(request, context, state);
    const element = await refHandle(page, request.ref);
    const options = clickOptionsFor(request);
    if (typeof request.offsetX === "number" || typeof request.offsetY === "number") {
      const box = await element.boundingBox();
      if (box !== null) {
        options.position = {
          x: box.width / 2 + (request.offsetX ?? 0),
          y: box.height / 2 + (request.offsetY ?? 0),
        };
      }
    }
    await element.click(options);
    await page.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => {});
    return { page, viewId, summary: "Clicked " + (request.element ?? request.ref) };
  },
  mouse_click_xy: async ({ request, context, state }) => {
    const { page, viewId } = await resolvePage(request, context, state);
    await page.mouse.click(request.x, request.y, {
      button: request.button === "right" || request.button === "middle" ? request.button : "left",
    });
    await page.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => {});
    return { page, viewId, summary: "Clicked at (" + String(request.x) + ", " + String(request.y) + ")" };
  },
  type: async ({ request, context, state }) => {
    const { page, viewId } = await resolvePage(request, context, state);
    const element = await refHandle(page, request.ref);
    await element.click({ timeout: ACTION_TIMEOUT_MS });
    if (request.clear === true) {
      await element.fill("").catch(() => {});
    }
    await page.keyboard.type(request.text, { delay: request.slowly === true ? 40 : 0 });
    if (request.submit === true) {
      await page.keyboard.press("Enter");
      await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
    }
    return { page, viewId, summary: "Typed into " + (request.element ?? request.ref) };
  },
  fill: async ({ request, context, state }) => {
    const { page, viewId } = await resolvePage(request, context, state);
    const element = await refHandle(page, request.ref);
    await element.fill(request.value);
    return { page, viewId, summary: "Filled " + (request.element ?? request.ref) };
  },
  fill_form: async ({ request, context, state }) => {
    const { page, viewId } = await resolvePage(request, context, state);
    let completed = 0;
    let submitAttempted = false;
    let submitted = false;
    let stage = "preflight";
    const handles = [];
    const fieldHandle = async field => {
      const element = await refHandle(page, field.ref);
      handles.push(element);
      const valid = await element.evaluate((el, field) => {
        const tag = el.tagName.toLowerCase();
        if ("checked" in field) return tag === "input" && el.type === "checkbox";
        if ("values" in field) return tag === "select" && (el.multiple || field.values.length === 1) && field.values.every(value => Array.from(el.options).some(option => option.value === value && !option.disabled && !(option.parentElement?.tagName === "OPTGROUP" && option.parentElement.disabled)));
        return tag === "textarea" || (tag === "input" && ["text", "search", "email", "tel", "url", "password", "number", "date", "time", "datetime-local", "month", "week"].includes(el.type));
      }, field);
      if (!valid || !await element.isVisible() || !await element.isEnabled() || ("value" in field && !await element.isEditable())) throw new Error("Field " + field.ref + " is not an available control of the requested type. Inspect fresh state.");
      return element;
    };
    const submitHandle = async (requireEnabled = true) => {
      const element = await refHandle(page, request.submitRef);
      handles.push(element);
      if (!await element.evaluate(el => el.matches('button, input[type="submit"], input[type="button"], [role="button"]')) || !await element.isVisible() || (requireEnabled && !await element.isEnabled())) throw new Error("Submit control is not an available button. Inspect fresh state.");
      return element;
    };
    try {
      // Validate every target before changing anything. Re-resolve each ref just
      // before use, so navigation or reactive replacement stops the sequence.
      for (const field of request.fields) await fieldHandle(field);
      if (request.submitRef) await submitHandle(false);
      for (const field of request.fields) {
        stage = "field " + String(completed + 1);
        const element = await fieldHandle(field);
        if ("checked" in field) await element.setChecked(field.checked, { timeout: 5000 });
        else if ("values" in field) await element.selectOption(field.values, { timeout: 5000 });
        else await element.fill(field.value, { timeout: 5000 });
        completed++;
      }
      if (request.submitRef) {
        stage = "submission";
        const element = await submitHandle();
        const waitScope = await element.ownerFrame() ?? page;
        submitAttempted = true;
        await element.click({ timeout: 5000 });
        submitted = true;
        if (request.waitFor) {
          stage = "confirmation";
          await waitScope.getByText(request.waitFor.text, { exact: false }).first().waitFor({ state: request.waitFor.state ?? "visible", timeout: request.waitFor.timeoutMs ?? 8000 });
        }
      }
      return { page, viewId, summary: "Filled " + completed + " fields" + (submitted ? "; clicked submit once" : "; did not submit") + (request.waitFor ? "; confirmation condition met: " + request.waitFor.text : "") };
    } catch (error) {
      return { page, viewId, error: String(error?.message ?? error), summary: "Stopped at " + stage + ". Completed " + completed + "/" + request.fields.length + " fields. " + (submitAttempted ? "Submission was attempted once; its effect may already have occurred. Do not repeat it without checking." : "Submission was not attempted.") + " No actions were rolled back. The failed step may have taken effect; inspect state before continuing." };
    } finally {
      await Promise.all(handles.map(handle => handle.dispose().catch(() => {})));
    }
  },
  select_option: async ({ request, context, state }) => {
    const { page, viewId } = await resolvePage(request, context, state);
    const element = await refHandle(page, request.ref);
    const values = Array.isArray(request.values) ? request.values : [];
    let selected;
    try {
      selected = await element.selectOption(values);
    } catch {
      selected = await element.selectOption(values.map((v) => ({ label: v })));
    }
    return {
      page,
      viewId,
      summary: "Selected " + JSON.stringify(selected) + " in " + (request.element ?? request.ref),
    };
  },
  press_key: async ({ request, context, state }) => {
    const { page, viewId } = await resolvePage(request, context, state);
    await page.keyboard.press(request.key);
    await page.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => {});
    return { page, viewId, summary: "Pressed " + request.key };
  },
  scroll: async ({ request, context, state }) => {
    const { page, viewId } = await resolvePage(request, context, state);
    if (typeof request.ref === "string" && request.ref.length > 0) {
      const element = await refHandle(page, request.ref);
      await element.scrollIntoViewIfNeeded();
      return { page, viewId, summary: "Scrolled " + (request.element ?? request.ref) + " into view" };
    }
    const amount = typeof request.amount === "number" && request.amount > 0 ? request.amount : 300;
    let deltaX = typeof request.deltaX === "number" ? request.deltaX : 0;
    let deltaY = typeof request.deltaY === "number" ? request.deltaY : 0;
    if (deltaX === 0 && deltaY === 0) {
      const direction = request.direction ?? "down";
      if (direction === "up") deltaY = -amount;
      else if (direction === "down") deltaY = amount;
      else if (direction === "left") deltaX = -amount;
      else deltaX = amount;
    }
    await page.mouse.wheel(deltaX, deltaY);
    await sleep(200);
    return { page, viewId, summary: "Scrolled by (" + String(deltaX) + ", " + String(deltaY) + ")" };
  },
  tabs: async ({ request, context, state }) => {
    const pages = context.pages().filter((p) => !p.isClosed());
    if (request.action === "list") {
      const entries = [];
      for (let i = 0; i < pages.length; i++) {
        const targetId = await targetIdOf(context, pages[i]);
        const viewId = Object.keys(state.views).find(key => key !== "default" && state.views[key] === targetId) ?? "tab-" + targetId;
        state.views[viewId] = targetId;
        state.urls[viewId] = pages[i].url();
        entries.push({
          index: i,
          viewId,
          url: pages[i].url(),
          title: await pages[i].title().catch(() => ""),
        });
      }
      return { summary: "Listed " + String(pages.length) + " tab(s)", data: JSON.stringify(entries, null, 1) };
    }
    if (request.action === "new") {
      const page = await context.newPage();
      const viewId = "tab-" + String(Date.now());
      state.views[viewId] = await targetIdOf(context, page);
      state.lastViewId = viewId;
      return { page, viewId, summary: "Opened a new tab" };
    }
    let page;
    if (request.strictView === true && typeof request.viewId === "string") {
      const target = state.views[request.viewId];
      for (const candidate of pages) {
        if (await targetIdOf(context, candidate) === target) { page = candidate; break; }
      }
      if (!page) throw new Error("This tab is no longer available. Refresh browser_tabs; no other tab was changed.");
    } else if (typeof request.index === "number") {
      page = pages[request.index];
      if (page === undefined) {
        throw new Error("No tab at index " + String(request.index) + " (" + String(pages.length) + " open)");
      }
    } else if (request.action === "close") {
      const currentTarget = state.lastViewId !== undefined ? state.views[state.lastViewId] : undefined;
      if (currentTarget !== undefined) {
        for (const p of pages) {
          try {
            if ((await targetIdOf(context, p)) === currentTarget) {
              page = p;
              break;
            }
          } catch {}
        }
      }
      if (page === undefined) {
        throw new Error("No current tab to close; pass an index from browser_tabs list.");
      }
    } else {
      throw new Error('Tab index is required for "' + String(request.action) + '".');
    }
    if (request.action === "select") {
      await page.bringToFront().catch(() => {});
      const targetId = await targetIdOf(context, page);
      let viewId = Object.keys(state.views).find((k) => state.views[k] === targetId);
      if (viewId === undefined) {
        viewId = "tab-" + String(Date.now());
        state.views[viewId] = targetId;
      }
      state.lastViewId = viewId;
      return { page, viewId, summary: "Selected tab " + viewId };
    }
    if (request.action === "close") {
      const targetId = await targetIdOf(context, page).catch(() => undefined);
      const closedUrl = page.url();
      await page.close();
      if (targetId !== undefined) {
        state.deletedViews = state.deletedViews ?? [];
        for (const key of Object.keys(state.views)) {
          if (state.views[key] === targetId) {
            delete state.views[key];
            state.deletedViews.push(key);
            if (state.lastViewId === key) state.lastViewId = undefined;
          }
        }
      }
      return { summary: "Closed tab (" + closedUrl + ")" };
    }
    throw new Error("Unknown tabs action: " + String(request.action));
  },
  screenshot: async ({ request, context, state }) => {
    const { page, viewId } = await resolvePage(request, context, state);
    return { page, viewId, summary: "Took a screenshot", fullPage: request.fullPage === true };
  },
  drag: async ({ request, context, state }) => {
    const { page, viewId } = await resolvePage(request, context, state);
    const source = await refHandle(page, request.sourceRef);
    await source.scrollIntoViewIfNeeded();
    const sourceBox = await source.boundingBox();
    if (sourceBox === null) throw new Error("The drag source has no visible bounding box.");
    let targetX;
    let targetY;
    if (typeof request.targetRef === "string" && request.targetRef.length > 0) {
      const target = await refHandle(page, request.targetRef);
      const targetBox = await target.boundingBox();
      if (targetBox === null) throw new Error("The drag target has no visible bounding box.");
      targetX = targetBox.x + targetBox.width / 2;
      targetY = targetBox.y + targetBox.height / 2;
    } else if (typeof request.targetX === "number" && typeof request.targetY === "number") {
      targetX = request.targetX;
      targetY = request.targetY;
    } else {
      throw new Error("drag needs targetRef or targetX/targetY.");
    }
    const startX = sourceBox.x + sourceBox.width / 2;
    const startY = sourceBox.y + sourceBox.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    const steps = 12;
    for (let i = 1; i <= steps; i++) {
      await page.mouse.move(
        startX + ((targetX - startX) * i) / steps,
        startY + ((targetY - startY) * i) / steps
      );
    }
    await page.mouse.up();
    return {
      page,
      viewId,
      summary:
        "Dragged " + request.sourceRef + " to (" + String(Math.round(targetX)) + ", " + String(Math.round(targetY)) + ")",
    };
  },
  get_bounding_box: async ({ request, context, state }) => {
    const { page, viewId } = await resolvePage(request, context, state);
    const element = await refHandle(page, request.ref);
    const box = await element.boundingBox();
    if (box === null) throw new Error("The element has no visible bounding box.");
    return {
      page,
      viewId,
      summary: "Bounding box for " + (request.element ?? request.ref),
      data: JSON.stringify({
        x: Math.round(box.x),
        y: Math.round(box.y),
        width: Math.round(box.width),
        height: Math.round(box.height),
      }),
    };
  },
  highlight: async ({ request, context, state }) => {
    const { page, viewId } = await resolvePage(request, context, state);
    await page.bringToFront().catch(() => {});
    const element = await refHandle(page, request.ref);
    await element.scrollIntoViewIfNeeded();
    const durationMs = Math.min(
      typeof request.durationMs === "number" && request.durationMs > 0 ? request.durationMs : 2000,
      5000
    );
    await element.evaluate((el, ms) => {
      const doc = el.ownerDocument;
      const rect = el.getBoundingClientRect();
      const overlay = doc.createElement("div");
      overlay.style.cssText =
        "position:fixed;z-index:2147483647;pointer-events:none;border:3px solid #ff4d4f;" +
        "border-radius:4px;background:rgba(255,77,79,0.15);" +
        "left:" + String(rect.left - 3) + "px;top:" + String(rect.top - 3) + "px;" +
        "width:" + String(rect.width) + "px;height:" + String(rect.height) + "px;";
      doc.body.appendChild(overlay);
      setTimeout(() => overlay.remove(), ms);
    }, durationMs);
    await sleep(300);
    return { page, viewId, summary: "Highlighted " + (request.element ?? request.ref) + " for " + String(durationMs) + "ms" };
  },
  cdp: async ({ request, context, state }) => {
    const method = typeof request.method === "string" ? request.method : "";
    const deniedPrefixes = [
      "Browser.",
      "Target.",
      "Storage.",
      "SystemInfo.",
      "Security.",
      "Input.",
      "Tethering.",
      "Cast.",
    ];
    const deniedMethods = [
      "Network.setCookie",
      "Network.setCookies",
      "Network.getCookies",
      "Network.getAllCookies",
      "Network.deleteCookies",
      "Network.clearBrowserCookies",
      "Network.clearBrowserCache",
    ];
    if (
      method.length === 0 ||
      deniedPrefixes.some((p) => method.startsWith(p)) ||
      deniedMethods.includes(method)
    ) {
      throw new Error(
        "CDP method " + JSON.stringify(method) + " is denied. Browser-wide, storage, cookie, cache, permission, target-management, and input commands are not allowed; use the dedicated browser tools instead."
      );
    }
    const { page, viewId } = await resolvePage(request, context, state);
    const session = await context.newCDPSession(page);
    try {
      const result = await session.send(method, request.params && typeof request.params === "object" ? request.params : {});
      let serialized = JSON.stringify(result);
      const max = 20000;
      if (serialized.length > max) {
        serialized = serialized.slice(0, max) + " \u2026(truncated " + String(serialized.length - max) + " chars)";
      }
      return { page, viewId, summary: "Ran CDP " + method, data: serialized };
    } finally {
      await session.detach().catch(() => {});
    }
  },
};

async function run(request) {
  await ensureChrome(request.cdpPort, request.display);
  const state = loadState(request.display);
  let connection;
  if (request.strictView === true) {
    const selected = await routedTarget(request, state);
    if (selected.result) return selected.result;
    connection = await scopedBrowserConnection(request.cdpPort, selected.targetId);
  } else await reviveDiscardedTabs(request.cdpPort);
  const { chromium } = await import("playwright-core");
  let browser;
  try {
    browser = await chromium.connectOverCDP(connection?.endpoint ?? "http://127.0.0.1:" + String(request.cdpPort), { timeout: 10000 });
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const loadedViews = { ...state.views };
    const loadedUrls = { ...state.urls };
    const loadedLastViewId = state.lastViewId;
    const op = OPS[request.op];
    if (op === undefined) throw new Error("Unknown op: " + String(request.op));
    const result = await op({ request, context, state });
    // Record the view's URL so a discard-churned target can be re-adopted by
    // URL on a later call (see resolvePage).
    if (result.viewId !== undefined && result.page !== undefined) {
      state.urls[result.viewId] = result.page.url();
    }
    // Persist only the entries THIS process changed. state holds a snapshot of
    // the whole file from loadState, and writing it back wholesale would let
    // a concurrent driver call's save clobber fresher mappings with stale
    // ones (e.g. undo the other call's post-discard re-adoption).
    const dirtyViews = {};
    for (const key of Object.keys(state.views)) {
      if (state.views[key] !== loadedViews[key]) dirtyViews[key] = state.views[key];
    }
    const dirtyUrls = {};
    for (const key of Object.keys(state.urls)) {
      if (state.urls[key] !== loadedUrls[key]) dirtyUrls[key] = state.urls[key];
    }
    saveState(request.display, {
      views: dirtyViews,
      urls: dirtyUrls,
      deletedViews: state.deletedViews,
      // Only when THIS op changed it: an op that never resolves a view (e.g.
      // tabs list) must not write the loaded value back over a concurrent
      // call's fresher one.
      lastViewId: state.lastViewId !== loadedLastViewId ? state.lastViewId : undefined,
    });
    // The routed assistant can act and inspect in one round trip, without
    // uploading an image or waiting for unrelated page resources to finish.
    if (request.snapshotAfter === true && result.page !== undefined && request.op !== "snapshot" && request.op !== "read") {
      await result.page.bringToFront().catch(() => {});
      try {
        const snapshot = await snapshotPage(result.page, { maxDepth: 20, compact: request.compact === true });
        result.data = (result.data ? result.data + "\\n\\n" : "") + snapshot.lines.join("\\n");
      } catch {
        result.data = (result.data ?? "") + "\\nAction completed; page changed before its snapshot. Call browser_snapshot. Do not repeat the action.";
      }
    }
    const out = { ok: !result.error, summary: result.summary };
    if (result.error) out.error = result.error;
    if (result.data !== undefined) out.data = result.data;
    if (result.viewId !== undefined) out.viewId = result.viewId;
    if (result.page !== undefined) {
      out.url = result.page.url();
      out.title = await bounded(result.page.title(), 1000, "Page title").catch(() => "");
      if (typeof request.screenshotPath === "string" && request.screenshotPath.length > 0) {
        mkdirSync(STATE_DIR, { recursive: true });
        await result.page
          .screenshot({
            path: request.screenshotPath,
            timeout: 8000,
            fullPage: result.fullPage === true,
          })
          .then(() => {
            out.screenshot = true;
          })
          .catch(() => {});
      }
    }
    return out;
  } finally {
    await browser?.close().catch(() => {});
    await connection?.close();
  }
}

const watchdog = setTimeout(() => {
  process.stdout.write(
    "\\n" + RESULT_MARKER + JSON.stringify({ ok: false, error: "Browser driver timed out after 90s" }) + "\\n"
  );
  process.exit(0);
}, 90000);

(async () => {
  let result;
  try {
    const raw = process.argv[2] ?? "";
    const request = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    result = await run(request);
  } catch (error) {
    result = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  clearTimeout(watchdog);
  process.stdout.write("\\n" + RESULT_MARKER + JSON.stringify(result) + "\\n");
  process.exit(0);
})();
`;

