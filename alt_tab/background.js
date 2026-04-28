/**
 * Alt Tab — service worker.
 *
 * Hosts all multi-step tab/window operations so they survive popup lifecycle.
 * Popup sends `{action, ...args}`; SW replies `{ok, ...info}` or `{ok:false, error}`.
 *
 * Core rule: when shuffling tabs we MOVE them (chrome.tabs.move / windows.create({tabId})).
 * We only create-by-url in session restore where tab objects do not exist — URLs only.
 */

const UNDO_KEY = 'altTabUndoSnapshot';
const UNDO_STORE_VERSION = 1;
const UNDO_JSON_CHUNK = 600_000;

const DAILY_STATS_KEY = 'altTabDailyCloseStats';

/**
 * Tabs created by a restore sit in this map (id → timestamp). When the tab
 * fires `status === 'complete'`, we inject a pause script to stop all
 * `<video>`/`<audio>` elements. Entries older than TTL are dropped so a
 * never-loaded tab does not leak storage forever.
 */
const PENDING_PAUSE_KEY = 'altTabPendingPauseIds';
const PENDING_PAUSE_TTL_MS = 10 * 60_000;

const RESTRICTED_URL_PREFIXES = [
  'chrome://',
  'chrome-extension://',
  'edge://',
  'about:',
  'devtools://',
];

function isRestrictedUrl(url) {
  if (!url) {return true;}
  for (const p of RESTRICTED_URL_PREFIXES) {
    if (url.startsWith(p)) {return true;}
  }
  return false;
}

function getDomain(url) {
  if (!url || typeof url !== 'string') {return '';}
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

function isValidHttpUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

const TRACKING_PARAMS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'fbclid', 'gclid', 'gbraid', 'wbraid', 'yclid', 'msclkid',
  'mc_cid', 'mc_eid', '_hsenc', '_hsmi', 'igshid', 'ref', 'ref_src',
];

function normalizeUrlForDedupe(url) {
  if (!url) {return '';}
  try {
    const u = new URL(url);
    u.hash = '';
    for (const p of TRACKING_PARAMS) {
      u.searchParams.delete(p);
    }
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.toString();
  } catch {
    return url;
  }
}

async function getAllNormalWindows() {
  const all = await chrome.windows.getAll({ populate: true });
  return all.filter((w) => w.type === 'normal' && Array.isArray(w.tabs));
}

async function getAllTabsFlat() {
  const windows = await getAllNormalWindows();
  return windows.flatMap((w) => w.tabs);
}

/**
 * Serialise current windows → `{<windowId>: [url, ...]}` under one storage key
 * with a short human-readable `label` describing what is about to happen.
 * Called BEFORE every destructive handler so Undo reverts to pre-op state.
 * Oversized payloads are split into chunks (`jp` array) just like presets.
 */
async function captureUndoSnapshot(label) {
  try {
    const windows = await getAllNormalWindows();
    const windowsData = {};
    let tabCount = 0;
    for (const w of windows) {
      const urls = w.tabs.map((t) => t.url || '');
      windowsData[w.id] = urls;
      tabCount += urls.length;
    }
    const json = JSON.stringify(windowsData);
    const payload = {
      v: UNDO_STORE_VERSION,
      tabCount,
      windowCount: windows.length,
      savedAt: Date.now(),
      label,
    };
    if (json.length <= UNDO_JSON_CHUNK) {
      payload.j = json;
    } else {
      payload.jp = [];
      for (let i = 0; i < json.length; i += UNDO_JSON_CHUNK) {
        payload.jp.push(json.slice(i, i + UNDO_JSON_CHUNK));
      }
    }
    await chrome.storage.local.set({ [UNDO_KEY]: payload });
  } catch (e) {
    console.warn('captureUndoSnapshot', label, e);
  }
}

/**
 * Load and deserialise the undo snapshot. Returns null if the slot is empty
 * or corrupt. Popup also calls this via the `get_undo_info` handler to decide
 * whether to show the Undo button.
 */
async function readUndoSnapshot() {
  try {
    const got = await chrome.storage.local.get(UNDO_KEY);
    const raw = got[UNDO_KEY];
    if (!raw || typeof raw !== 'object') {return null;}
    let jsonStr;
    if (typeof raw.j === 'string') {jsonStr = raw.j;}
    else if (Array.isArray(raw.jp) && raw.jp.length) {jsonStr = raw.jp.join('');}
    else {return null;}
    const windowsData = JSON.parse(jsonStr);
    return {
      windowsData,
      tabCount: raw.tabCount ?? 0,
      windowCount: raw.windowCount ?? 0,
      savedAt: raw.savedAt ?? 0,
      label: raw.label ?? 'last action',
    };
  } catch (e) {
    console.warn('readUndoSnapshot', e);
    return null;
  }
}

async function bumpDailyCloseStats(kind, delta) {
  if (delta <= 0) {return;}
  try {
    const got = await chrome.storage.local.get(DAILY_STATS_KEY);
    let rec = got[DAILY_STATS_KEY];
    const day = new Date().toISOString().slice(0, 10);
    if (!rec || rec.day !== day) {
      rec = { day, dupTabs: 0, domainTabs: 0 };
    }
    if (kind === 'dup') {rec.dupTabs = (rec.dupTabs || 0) + delta;}
    else if (kind === 'domain') {rec.domainTabs = (rec.domainTabs || 0) + delta;}
    await chrome.storage.local.set({ [DAILY_STATS_KEY]: rec });
  } catch (e) {
    console.warn('bumpDailyCloseStats', e);
  }
}

/**
 * Sort each normal window by sortType. Does not move tabs across windows.
 * Does not recreate tabs — only chrome.tabs.move.
 */
async function sortTabs(sortType) {
  const windows = await getAllNormalWindows();

  const sorter = (a, b) => {
    switch (sortType) {
      case 'sort_by_name':
        return (a.title || '').localeCompare(b.title || '');
      case 'sort_by_domain':
        return getDomain(a.url).localeCompare(getDomain(b.url));
      case 'sort_by_last_visit': {
        const av = a.lastAccessed ?? 0;
        const bv = b.lastAccessed ?? 0;
        return bv - av;
      }
      case 'sort_by_creation_time':
        return a.id - b.id;
      default:
        return 0;
    }
  };

  for (const w of windows) {
    const sorted = [...w.tabs].sort(sorter);
    const tabIds = sorted.map((t) => t.id);
    try {
      await chrome.tabs.move(tabIds, { windowId: w.id, index: 0 });
    } catch (error) {
      console.warn(`sort: could not move tabs in window ${w.id}`, error);
    }
  }
}

/**
 * Move `tabsToMove` into a new normal window.
 * The FIRST tab is lifted into a new window via windows.create({tabId}) — no URL reopening.
 * The rest follow via tabs.move to the same windowId.
 * Does not touch mute/media state — extract/regroup preserve whatever was playing.
 * (Silencing is reserved for session restore, where URLs are opened fresh.)
 * Returns the created windowId.
 */
async function moveTabsToNewWindow(tabsToMove) {
  if (tabsToMove.length === 0) {return null;}
  const [first, ...rest] = tabsToMove;
  const win = await chrome.windows.create({ tabId: first.id, state: 'normal' });
  if (rest.length) {
    await chrome.tabs.move(
      rest.map((t) => t.id),
      { windowId: win.id, index: -1 }
    );
  }
  return win.id;
}

/**
 * Extract every tab whose title OR url contains `needle` (case-insensitive)
 * into a single new window. Existing tabs are moved, not recreated.
 */
async function extractByString(needle) {
  const q = (needle || '').trim().toLowerCase();
  if (!q) {return { ok: false, error: 'empty search' };}
  const all = await getAllTabsFlat();
  const matching = all.filter(
    (t) =>
      (t.title && t.title.toLowerCase().includes(q)) ||
      (t.url && t.url.toLowerCase().includes(q))
  );
  if (matching.length === 0) {return { ok: false, error: 'no matches' };}
  await moveTabsToNewWindow(matching);
  return { ok: true, count: matching.length };
}

/**
 * Collect every tab in any window whose domain matches the active tab's domain
 * and move them into one new window.
 */
async function extractCurrentDomain(activeTabId) {
  const active = await resolveActiveTab(activeTabId);
  if (!active?.url || isRestrictedUrl(active.url)) {
    return { ok: false, error: 'active tab is not a normal web page' };
  }
  const domain = getDomain(active.url);
  if (!domain) {return { ok: false, error: 'could not read domain' };}

  const all = await getAllTabsFlat();
  const matching = all.filter(
    (t) => t.url && !isRestrictedUrl(t.url) && getDomain(t.url) === domain
  );
  if (matching.length === 0) {return { ok: false, error: 'no matching tabs' };}
  await moveTabsToNewWindow(matching);
  return { ok: true, count: matching.length, domain };
}

/**
 * Split all tabs across all windows by hostname.
 * Domains with ≥3 tabs become their own window; the rest pool into one "misc" window.
 * Restricted URLs are ignored.
 */
async function regroupByDomain() {
  const all = await getAllTabsFlat();
  const byDomain = new Map();
  for (const tab of all) {
    if (!tab.url || isRestrictedUrl(tab.url)) {continue;}
    const d = getDomain(tab.url);
    if (!d) {continue;}
    if (!byDomain.has(d)) {byDomain.set(d, []);}
    byDomain.get(d).push(tab);
  }

  const bigGroups = [];
  const leftovers = [];
  for (const group of byDomain.values()) {
    if (group.length >= 3) {bigGroups.push(group);}
    else {leftovers.push(...group);}
  }
  if (leftovers.length > 0) {bigGroups.push(leftovers);}

  if (bigGroups.length === 0) {
    return { ok: false, error: 'no web tabs to split' };
  }
  let created = 0;
  for (const group of bigGroups) {
    if (group.length === 0) {continue;}
    await moveTabsToNewWindow(group);
    created++;
  }
  return { ok: true, windows: created };
}

/**
 * Move all tabs from non-focused normal windows into the focused window, then close the empties.
 * Uses tabs.move only — no recreation. chrome.tabs.move drops the `pinned` flag
 * when tabs cross window boundaries, so we re-pin afterwards per saved id.
 */
async function mergeAllWindows() {
  const current = await chrome.windows.getCurrent();
  const targetId = current.id;
  const windows = await getAllNormalWindows();
  if (windows.length <= 1) {return { ok: false, error: 'only one window' };}

  const pinnedIds = [];
  for (const w of windows) {
    if (w.id === targetId) {continue;}
    const ids = w.tabs.map((t) => t.id);
    for (const t of w.tabs) {
      if (t.pinned) {pinnedIds.push(t.id);}
    }
    if (ids.length) {
      await chrome.tabs.move(ids, { windowId: targetId, index: -1 });
    }
    try {
      await chrome.windows.remove(w.id);
    } catch {
      /* window may already be gone */
    }
  }
  for (const id of pinnedIds) {
    try {
      await chrome.tabs.update(id, { pinned: true });
    } catch {
      /* tab gone */
    }
  }
  await chrome.windows.update(targetId, { focused: true });
  return { ok: true };
}

/**
 * Create tabGroups inside the current window, one per hostname having ≥2 tabs.
 * No windows created, no tabs recreated.
 */
async function groupByDomainTabGroups() {
  const current = await chrome.windows.getCurrent({ populate: true });
  if (current.type !== 'normal' || !current.tabs?.length) {
    return { ok: false, error: 'no tabs in this window' };
  }
  const byDomain = new Map();
  for (const tab of current.tabs) {
    if (!tab.url || isRestrictedUrl(tab.url)) {continue;}
    const d = getDomain(tab.url);
    if (!d) {continue;}
    if (!byDomain.has(d)) {byDomain.set(d, []);}
    byDomain.get(d).push(tab.id);
  }
  let groups = 0;
  for (const [domain, ids] of byDomain) {
    if (ids.length < 2) {continue;}
    const title = domain.length > 32 ? `${domain.slice(0, 29)}…` : domain;
    const groupId = await chrome.tabs.group({
      tabIds: ids,
      createProperties: { windowId: current.id },
    });
    await chrome.tabGroups.update(groupId, { title });
    groups++;
  }
  return { ok: true, groups };
}

/**
 * Session restore.
 *
 * `windowsData` is `{ <windowIdOrAny>: [url, url, ...] }` — IDs from export are ignored
 * here (they refer to previous Chrome session), we only care about grouping.
 *
 * mode='replace': close other normal windows, rebuild the current window to host
 *   the first group, then create new windows for the remaining groups.
 *   BUG-02 fix: we remove ALL surplus old tabs FIRST (except one pivot),
 *   then update pivot URL, then create the rest — no misaligned slice.
 *
 * mode='append': open each group as a brand-new window alongside the current ones.
 *
 * Only http(s) URLs are restored (chrome:// etc. cannot be loaded by extensions).
 */
/**
 * Mute every tab id in parallel. tabs.update supports the `muted` property
 * but tabs.create does not, so we always do this as a second pass after
 * a restore. Individual failures (tab closed mid-flight) are swallowed.
 */
async function muteTabs(tabIds) {
  if (!tabIds?.length) {return;}
  await Promise.allSettled(
    tabIds.map((id) => chrome.tabs.update(id, { muted: true }))
  );
}

/**
 * Silence every given tab: mute, try to pause media right now (for tabs
 * already loaded — moves and extract targets), and register for
 * pause-on-complete (for tabs still loading — fresh restored URLs).
 * One helper covers both move-based and recreate-based operations.
 */
async function silenceTabs(tabIds) {
  if (!tabIds?.length) {return;}
  await muteTabs(tabIds);
  await Promise.allSettled(tabIds.map((id) => pauseMediaInTab(id)));
  await markPendingPause(tabIds);
}

/**
 * Register these tab ids so that when each fires `status:'complete'` the
 * onUpdated listener injects a pause script. Persisted in storage so that
 * the SW surviving a restart still honours pending entries.
 */
async function markPendingPause(tabIds) {
  if (!tabIds?.length) {return;}
  try {
    const got = await chrome.storage.local.get(PENDING_PAUSE_KEY);
    const existing = got[PENDING_PAUSE_KEY] ?? {};
    const now = Date.now();
    for (const id of tabIds) {
      existing[String(id)] = now;
    }
    // Drop entries older than TTL to avoid unbounded growth.
    for (const k of Object.keys(existing)) {
      if (now - existing[k] > PENDING_PAUSE_TTL_MS) {
        delete existing[k];
      }
    }
    await chrome.storage.local.set({ [PENDING_PAUSE_KEY]: existing });
  } catch (e) {
    console.warn('markPendingPause', e);
  }
}

async function consumePendingPause(tabId) {
  try {
    const got = await chrome.storage.local.get(PENDING_PAUSE_KEY);
    const existing = got[PENDING_PAUSE_KEY] ?? {};
    const key = String(tabId);
    if (existing[key] == null) {return false;}
    delete existing[key];
    await chrome.storage.local.set({ [PENDING_PAUSE_KEY]: existing });
    return true;
  } catch {
    return false;
  }
}

/**
 * Inject a one-shot script that calls .pause() on every video/audio element
 * found in the page. Fails silently on chrome://, file:// and other pages
 * where scripting is not allowed.
 */
async function pauseMediaInTab(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        for (const el of document.querySelectorAll('video, audio')) {
          try {
            el.pause();
          } catch {
            /* element may be in an odd state */
          }
        }
      },
    });
  } catch {
    /* restricted URL or tab gone */
  }
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') {return;}
  const pending = await consumePendingPause(tabId);
  if (pending) {
    await pauseMediaInTab(tabId);
  }
});

async function restoreSession(mode, windowsData) {
  if (!windowsData || typeof windowsData !== 'object') {
    return { ok: false, error: 'bad payload' };
  }

  const rawGroups = Object.values(windowsData).filter(
    (urls) => Array.isArray(urls) && urls.length
  );
  const totalUrls = rawGroups.reduce((a, urls) => a + urls.length, 0);
  const groups = rawGroups
    .map((urls) => urls.filter(isValidHttpUrl))
    .filter((urls) => urls.length > 0);
  const kept = groups.reduce((a, urls) => a + urls.length, 0);
  const skipped = totalUrls - kept;

  if (groups.length === 0) {
    return { ok: false, error: 'no valid http(s) URLs' };
  }

  // Every tab we create or retarget — we mute them all at the end so
  // mass-restore of 50 YouTube links doesn't explode into a choir.
  const createdTabIds = [];

  if (mode === 'append') {
    let lastWinId = null;
    for (const urls of groups) {
      const win = await chrome.windows.create({
        url: urls,
        focused: false,
        state: 'normal',
      });
      if (win?.tabs) {
        createdTabIds.push(...win.tabs.map((t) => t.id));
      }
      lastWinId = win?.id ?? null;
    }
    await silenceTabs(createdTabIds);
    if (lastWinId !== null) {
      try {
        await chrome.windows.update(lastWinId, { focused: true });
      } catch {
        /* window closed mid-op */
      }
    }
    const tabCount = groups.reduce((a, urls) => a + urls.length, 0);
    return { ok: true, tabCount, windowCount: groups.length, skipped };
  }

  // mode === 'replace'
  const current = await chrome.windows.getCurrent();
  const all = await getAllNormalWindows();
  const others = all.filter((w) => w.id !== current.id);
  for (const w of others) {
    try {
      await chrome.windows.remove(w.id);
    } catch {
      /* ignore */
    }
  }

  const firstUrls = groups[0];
  const curTabs = await chrome.tabs.query({ windowId: current.id });

  if (curTabs.length === 0) {
    const t = await chrome.tabs.create({
      windowId: current.id,
      url: firstUrls[0],
      active: true,
    });
    if (t?.id != null) {createdTabIds.push(t.id);}
  } else {
    // Pivot: keep the first existing tab, retarget it. Remove every other old tab
    // BEFORE creating new tabs — avoids the buggy slice math of the previous impl.
    const pivot = curTabs[0];
    const toClose = curTabs.slice(1).map((t) => t.id);
    if (toClose.length) {
      await chrome.tabs.remove(toClose);
    }
    await chrome.tabs.update(pivot.id, {
      url: firstUrls[0],
      active: true,
    });
    createdTabIds.push(pivot.id);
  }
  for (let i = 1; i < firstUrls.length; i++) {
    const t = await chrome.tabs.create({
      windowId: current.id,
      url: firstUrls[i],
      active: false,
    });
    if (t?.id != null) {createdTabIds.push(t.id);}
  }

  let lastWinId = current.id;
  for (let g = 1; g < groups.length; g++) {
    const win = await chrome.windows.create({
      url: groups[g],
      focused: false,
      state: 'normal',
    });
    if (win?.tabs) {
      createdTabIds.push(...win.tabs.map((t) => t.id));
    }
    lastWinId = win?.id ?? lastWinId;
  }

  await muteTabs(createdTabIds);
  await markPendingPause(createdTabIds);

  try {
    await chrome.windows.update(lastWinId, { focused: true });
  } catch {
    /* ignore */
  }
  const tabCount = groups.reduce((a, urls) => a + urls.length, 0);
  return { ok: true, tabCount, windowCount: groups.length, skipped };
}

/**
 * Resolve the "active tab" from the popup's perspective.
 * chrome.tabs.query({active:true, lastFocusedWindow:true}) inside the SW
 * is unreliable — when the popup is focused it may point at the popup's
 * overlay window. Popup passes its own active tab id in `activeTabId`;
 * we fall back to querying normal windows only.
 */
async function resolveActiveTab(activeTabId) {
  if (typeof activeTabId === 'number') {
    try {
      return await chrome.tabs.get(activeTabId);
    } catch {
      /* tab gone; fall through */
    }
  }
  const windows = await getAllNormalWindows();
  const focused = windows.find((w) => w.focused) ?? windows[0];
  return focused?.tabs?.find((t) => t.active) ?? null;
}

/**
 * Close every tab whose domain matches the active tab.
 * Increments the daily stats under `domain`.
 */
async function closeThisDomain(activeTabId) {
  const active = await resolveActiveTab(activeTabId);
  if (!active?.url || isRestrictedUrl(active.url)) {
    return { ok: false, error: 'active tab is not a normal web page' };
  }
  const domain = getDomain(active.url);
  if (!domain) {return { ok: false, error: 'could not read domain' };}
  const all = await getAllTabsFlat();
  const matching = all.filter(
    (t) => t.url && !isRestrictedUrl(t.url) && getDomain(t.url) === domain
  );
  if (matching.length === 0) {return { ok: false, error: 'no matching tabs' };}
  await chrome.tabs.remove(matching.map((t) => t.id));
  await bumpDailyCloseStats('domain', matching.length);
  return { ok: true, count: matching.length, domain };
}

async function countDuplicates() {
  const tabs = await getAllTabsFlat();
  const seen = new Set();
  let n = 0;
  for (const tab of tabs) {
    const key = normalizeUrlForDedupe(tab.url || '');
    if (seen.has(key)) {n++;}
    else {seen.add(key);}
  }
  return { ok: true, count: n };
}

/**
 * Close duplicate tabs using normalised URL matching (strips hash + common
 * tracking params + trailing slash on non-root paths). Scans normal windows only —
 * PWA / devtools / popup windows are not considered.
 */
async function removeDuplicates() {
  const tabs = await getAllTabsFlat();
  const seen = new Set();
  const dupIds = [];
  for (const tab of tabs) {
    const key = normalizeUrlForDedupe(tab.url || '');
    if (seen.has(key)) {dupIds.push(tab.id);}
    else {seen.add(key);}
  }
  if (dupIds.length === 0) {return { ok: true, count: 0 };}
  await chrome.tabs.remove(dupIds);
  await bumpDailyCloseStats('dup', dupIds.length);
  return { ok: true, count: dupIds.length };
}

/**
 * Create a fresh new-tab page, then close every tab that existed beforehand.
 * Caller is responsible for downloading a session backup first (popup does).
 */
async function deleteAllTabs(defaultUrl) {
  const beforeTabs = await getAllTabsFlat();
  const beforeIds = beforeTabs.map((t) => t.id);
  if (beforeIds.length === 0) {return { ok: true, count: 0 };}
  await chrome.tabs.create({ url: defaultUrl || 'chrome://newtab/', active: true });
  await chrome.tabs.remove(beforeIds);
  return { ok: true, count: beforeIds.length };
}

/** Resolve the Undo button label from the handler name. Keep short — shown in header. */
const UNDO_LABELS = {
  restore_session: 'session restore',
  regroup_by_domain: 'regroup by domain',
  extract_current_domain: 'extract this domain',
  extract_by_string: 'extract by string',
  merge_all_windows: 'merge all windows',
  close_this_domain: 'close this domain',
  remove_duplicates: 'close duplicates',
  delete_all_tabs: 'delete all',
};

const UNDOABLE_ACTIONS = new Set(Object.keys(UNDO_LABELS));

/**
 * Restore the latest undo snapshot and replace it with a fresh pre-undo snapshot
 * so the next Undo click toggles back — classic undo/redo pair.
 * If the second capture fails we still return the restore result; next Undo
 * will simply be a no-op with the stale slot.
 */
async function undoLastAction() {
  const snap = await readUndoSnapshot();
  if (!snap) {return { ok: false, error: 'nothing to undo' };}
  await captureUndoSnapshot(`redo ${snap.label}`);
  return restoreSession('replace', snap.windowsData);
}

const HANDLERS = {
  sort: (req) => sortTabs(req.sortType),
  extract_by_string: (req) => extractByString(req.needle),
  extract_current_domain: (req) => extractCurrentDomain(req.activeTabId),
  regroup_by_domain: () => regroupByDomain(),
  merge_all_windows: () => mergeAllWindows(),
  group_by_domain_tab_groups: () => groupByDomainTabGroups(),
  restore_session: (req) => restoreSession(req.mode, req.windowsData),
  close_this_domain: (req) => closeThisDomain(req.activeTabId),
  remove_duplicates: () => removeDuplicates(),
  count_duplicates: () => countDuplicates(),
  delete_all_tabs: (req) => deleteAllTabs(req.defaultUrl),
  get_undo_info: async () => {
    const snap = await readUndoSnapshot();
    if (!snap) {return { ok: true, empty: true };}
    return {
      ok: true,
      empty: false,
      label: snap.label,
      tabCount: snap.tabCount,
      windowCount: snap.windowCount,
      savedAt: snap.savedAt,
    };
  },
  undo: () => undoLastAction(),
  clear_undo: async () => {
    try {
      await chrome.storage.local.remove(UNDO_KEY);
    } catch (e) {
      console.warn('clear_undo', e);
    }
    return { ok: true };
  },
};

chrome.commands.onCommand.addListener((command) => {
  sortTabs(command);
});

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  const action = request?.action;
  const handler = HANDLERS[action];
  if (!handler) {return false;}
  (async () => {
    try {
      if (UNDOABLE_ACTIONS.has(action)) {
        await captureUndoSnapshot(UNDO_LABELS[action]);
      }
      const result = await handler(request);
      sendResponse(result ?? { ok: true });
    } catch (e) {
      console.warn('handler failed', action, e);
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true; // keep the message channel open for async sendResponse
});
