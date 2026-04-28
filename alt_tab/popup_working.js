/**
 * Alt Tab — popup logic (single file)
 */
document.addEventListener('DOMContentLoaded', async () => {
  const DEFAULT_URL = 'chrome://newtab/';
  const THEME_ORDER = ['system', 'dark', 'light'];
  const THEME_ICONS = { system: '◐', dark: '●', light: '○' };
  const THEME_LABELS = { system: 'System', dark: 'Dark', light: 'Light' };

  /** Session file JSON and preset blob — bump when on-disk / stored shape changes */
  const ALT_TAB_SESSION_FILE_VERSION = 2;
  const ALT_TAB_PRESET_STORE_VERSION = 9;
  const ALT_TAB_STORAGE_QUOTA_HINT =
    'Snapshot too large for built-in storage — use Session → Save to file.';
  const ALT_TAB_DAILY_STATS_KEY = 'altTabDailyCloseStats';

  /** Legacy: all slots in one key (could exceed per-item size limit). */
  const PRESET_STORAGE_KEY = 'sessionPresetSlotsV1';
  const PRESET_SLOT_KEYS = [
    'altTabPresetSlot0',
    'altTabPresetSlot1',
    'altTabPresetSlot2',
    'altTabPresetSlot3',
  ];
  /** Max chars per string in `jp` chunk array (single storage value must stay clone-friendly). */
  const PRESET_JSON_CHUNK = 600_000;
  const PRESET_INDEX = [1, 2, 3, 4];

  // MV3 guarantees chrome.storage.local is available in popup context.
  // Both set/get/remove return native Promises in MV3 manifest v3 popups.
  const storageLocalSet = (items) => chrome.storage.local.set(items);
  const storageLocalGet = (keys) => chrome.storage.local.get(keys);
  const storageLocalRemove = (keys) => chrome.storage.local.remove(keys);

  function normalizeWindowsDataForStorage(windowsData) {
    const out = {};
    if (!windowsData || typeof windowsData !== 'object') {
      return out;
    }
    for (const wid of Object.keys(windowsData)) {
      const urls = windowsData[wid];
      if (!Array.isArray(urls)) {
        continue;
      }
      out[wid] = urls.map((u) => (u == null ? '' : String(u)));
    }
    return out;
  }

  function parseWindowsDataFromPresetRaw(raw) {
    if (!raw || typeof raw !== 'object') {
      return null;
    }
    let jsonStr;
    if (typeof raw.j === 'string') {
      jsonStr = raw.j;
    } else if (Array.isArray(raw.jp) && raw.jp.length) {
      jsonStr = raw.jp.join('');
    } else if (typeof raw.windowsDataJson === 'string') {
      jsonStr = raw.windowsDataJson;
    } else {
      return null;
    }
    try {
      return JSON.parse(jsonStr);
    } catch {
      return null;
    }
  }

  function buildPresetStoragePayload(windowsData, tabCount, windowCount, savedAt) {
    const normalized = normalizeWindowsDataForStorage(windowsData);
    const json = JSON.stringify(normalized);
    const payload = {
      v: ALT_TAB_PRESET_STORE_VERSION,
      tabCount,
      windowCount,
      savedAt,
    };
    if (json.length <= PRESET_JSON_CHUNK) {
      payload.j = json;
    } else {
      payload.jp = [];
      for (let i = 0; i < json.length; i += PRESET_JSON_CHUNK) {
        payload.jp.push(json.slice(i, i + PRESET_JSON_CHUNK));
      }
    }
    return payload;
  }

  function todayIsoDate() {
    return new Date().toISOString().slice(0, 10);
  }

  async function refreshDailyStatsLine() {
    const el = elements.dailyStats;
    if (!el) {
      return;
    }
    try {
      const got = await storageLocalGet(ALT_TAB_DAILY_STATS_KEY);
      const rec = got[ALT_TAB_DAILY_STATS_KEY];
      const day = todayIsoDate();
      if (!rec || rec.day !== day) {
        el.textContent = 'Today: 0 dup · 0 domain';
      } else {
        const d = rec.dupTabs || 0;
        const dom = rec.domainTabs || 0;
        el.textContent = `Today: ${d} dup · ${dom} domain`;
      }
    } catch (e) {
      console.warn('refreshDailyStatsLine', e);
      el.textContent = 'Today: —';
    }
  }

  const elements = {
    statsPanel: document.getElementById('stats_panel'),
    dailyStats: document.getElementById('daily_stats'),
    themeToggle: document.getElementById('theme_toggle'),
    themeIcon: document.getElementById('theme_icon'),
    undoBtn: document.getElementById('undo_btn'),
    undoLabel: document.getElementById('undo_label'),
    statusBar: document.getElementById('status_bar'),
    sortTabs: document.getElementById('sort_tabs'),
    sortTabsByDomain: document.getElementById('sort_tabs_by_domain'),
    sortTabsLastVisited: document.getElementById('sort_tabs_last_visited'),
    sortTabsCreated: document.getElementById('sort_tabs_created'),
    mergeWindows: document.getElementById('merge_windows'),
    regroupTabs: document.getElementById('regroup_tabs'),
    extractDomain: document.getElementById('extract_domain'),
    groupTabGroups: document.getElementById('group_tab_groups'),
    muteAllBtn: document.getElementById('mute_all'),
    closeThisDomain: document.getElementById('close_this_domain'),
    removeDuplicates: document.getElementById('remove_duplicates'),
    extractString: document.getElementById('extract_string'),
    extractMatchLine: document.getElementById('extract_match_line'),
    extractTabs: document.getElementById('extract_tabs'),
    saveTabs: document.getElementById('save_tabs'),
    loadTabs: document.getElementById('load_tabs'),
    appendTabs: document.getElementById('append_tabs'),
    fileInput: document.getElementById('file_input'),
    closeTabs: document.getElementById('close_tabs'),
    copyMd: document.getElementById('copy_md'),
    jumpQuery: document.getElementById('jump_query'),
    jumpResults: document.getElementById('jump_results'),
    presetHold: PRESET_INDEX.map((n) => document.getElementById(`preset_hold_${n}`)),
    presetFetch: PRESET_INDEX.map((n) => document.getElementById(`preset_fetch_${n}`)),
  };

  let statusClear;

  function setStatus(message, level = 'info', ms = 3800) {
    if (!elements.statusBar) {return;}
    clearTimeout(statusClear);
    elements.statusBar.textContent = message || '';
    elements.statusBar.dataset.level = level;
    if (message && ms > 0) {
      statusClear = setTimeout(() => {
        elements.statusBar.textContent = '';
        elements.statusBar.dataset.level = 'info';
      }, ms);
    }
  }

  function getDomainFromUrl(url) {
    if (!url || typeof url !== 'string') {return '';}
    try {
      const u = new URL(url);
      return u.hostname.replace(/^www\./i, '');
    } catch {
      return '';
    }
  }

  function isRestrictedUrl(url) {
    if (!url) {return true;}
    return (
      url.startsWith('chrome://') ||
      url.startsWith('chrome-extension://') ||
      url.startsWith('edge://') ||
      url.startsWith('about:') ||
      url.startsWith('devtools://')
    );
  }


  function formatDateForFilename() {
    return new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .replace('T', '_')
      .slice(0, 19);
  }

  async function applyThemeFromStorage() {
    const { themePref = 'system' } = await storageLocalGet('themePref');
    const pref = THEME_ORDER.includes(themePref) ? themePref : 'system';
    document.documentElement.setAttribute('data-theme', pref);
    if (elements.themeIcon) {elements.themeIcon.textContent = THEME_ICONS[pref];}
    if (elements.themeToggle) {
      elements.themeToggle.title =
        `Now: ${THEME_LABELS[pref]}\nClick cycles System, dark, and light\nSaved in local storage`;
    }
  }

  async function cycleTheme() {
    const { themePref = 'system' } = await storageLocalGet('themePref');
    const i = THEME_ORDER.indexOf(themePref);
    const next = THEME_ORDER[(i + 1) % THEME_ORDER.length];
    await storageLocalSet({ themePref: next });
    await applyThemeFromStorage();
    setStatus(`Theme: ${THEME_LABELS[next]}`, 'success', 2200);
  }

  async function updateStats() {
    try {
      const normal = await getNormalWindowsCached();
      const tabCount = normal.reduce((a, w) => a + w.tabs.length, 0);
      if (elements.statsPanel) {
        elements.statsPanel.textContent = `${normal.length} windows · ${tabCount} tabs`;
      }
    } catch (e) {
      console.warn('updateStats', e);
      if (elements.statsPanel) {
        elements.statsPanel.textContent = 'Stats unavailable';
      }
    }
  }

  function formatRelativeTime(ts) {
    if (!ts) {return '';}
    const sec = Math.floor((Date.now() - ts) / 1000);
    if (sec < 45) {return 'just now';}
    if (sec < 3600) {return `${Math.floor(sec / 60)}m ago`;}
    if (sec < 86400) {return `${Math.floor(sec / 3600)}h ago`;}
    return `${Math.floor(sec / 86400)}d ago`;
  }

  /**
   * Read the undo snapshot from the SW and show/hide the header Undo button.
   * Called on popup open and after every destructive op finishes.
   */
  async function refreshUndoButton() {
    const btn = elements.undoBtn;
    const label = elements.undoLabel;
    if (!btn || !label) {return;}
    const info = await callSw({ action: 'get_undo_info' });
    if (!info.ok || info.empty) {
      btn.disabled = true;
      label.textContent = 'Nothing to undo';
      btn.setAttribute(
        'title',
        'Undo appears here after a bulk action\n(close, extract, merge, regroup, load, fetch)'
      );
      return;
    }
    btn.disabled = false;
    label.textContent = `Undo ${info.label}`;
    btn.setAttribute(
      'title',
      `Undo ${info.label}\n${info.tabCount} tab(s) · ${info.windowCount} window(s) · ${formatRelativeTime(info.savedAt)}`
    );
  }

  async function performUndo() {
    setStatus('Undoing…', 'info', 0);
    const res = await callSw({ action: 'undo' });
    if (res.ok) {
      setStatus(
        `Undone — restored ${res.tabCount} tab(s) in ${res.windowCount} window(s).`,
        'success'
      );
      // SW has already captured a fresh pre-undo snapshot, so the button
      // now toggles back (redo). Just re-render it.
      refreshUndoButton();
      updateStats();
    } else if (res.error === 'nothing to undo') {
      setStatus('Nothing to undo.', 'info');
      refreshUndoButton();
    } else {
      setStatus('Undo failed.', 'error');
    }
  }

  /**
   * Cache `windows.getAll({populate:true})` for ~1s. Tooltip handlers fire on
   * every hover; without this a popup sitting open produces a burst of IPCs.
   * Popup lifetime is seconds, so 1s TTL is safely invalidated by any real op.
   */
  const windowsCache = { t: 0, value: null };
  const WINDOWS_CACHE_TTL_MS = 1000;
  async function getNormalWindowsCached() {
    if (windowsCache.value && Date.now() - windowsCache.t < WINDOWS_CACHE_TTL_MS) {
      return windowsCache.value;
    }
    const all = await chrome.windows.getAll({ populate: true });
    windowsCache.value = all.filter((w) => w.type === 'normal' && Array.isArray(w.tabs));
    windowsCache.t = Date.now();
    return windowsCache.value;
  }
  function invalidateWindowsCache() {
    windowsCache.t = 0;
    windowsCache.value = null;
  }

  async function getAllTabsAllWindows() {
    const windows = await getNormalWindowsCached();
    return windows.flatMap((w) => w.tabs);
  }

  /**
   * Resolve the active tab the user is looking at *through* the popup.
   * `currentWindow: true` works in the popup (it maps to the owning browser
   * window), unlike `lastFocusedWindow` which the SW sees as unreliable
   * once the popup overlay takes focus.
   */
  async function getActiveTabId() {
    try {
      const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
      return t?.id ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Thin wrapper around chrome.runtime.sendMessage that normalises the
   * SW response into an { ok, ...info, error? } shape and never throws.
   * All multi-step tab/window ops live in background.js so they survive
   * popup lifecycle (popup dies on focus loss from chrome.windows.create).
   */
  async function callSw(request) {
    try {
      const res = await chrome.runtime.sendMessage(request);
      // Any SW ack may reflect a mutation; drop cached window snapshot so
      // subsequent tooltip refreshes fetch fresh data.
      invalidateWindowsCache();
      return res ?? { ok: false, error: 'no response' };
    } catch (e) {
      console.warn('sendMessage', request?.action, e);
      return { ok: false, error: String(e?.message || e) };
    }
  }

  async function sortTabs(sortType) {
    setStatus('Sorting…', 'info', 0);
    const res = await callSw({ action: 'sort', sortType });
    if (res.ok) {
      setStatus('Tabs reordered.', 'success');
      updateStats();
    } else {
      setStatus('Could not sort tabs.', 'error');
    }
  }

  async function mergeAllWindows() {
    setStatus('Merging…', 'info', 0);
    const res = await callSw({ action: 'merge_all_windows' });
    if (res.ok) {
      setStatus('All tabs moved into this window.', 'success');
      refreshUndoButton();
      updateStats();
    } else if (res.error === 'only one window') {
      setStatus('Only one window — nothing to merge.', 'info');
    } else {
      setStatus('Merge failed.', 'error');
    }
  }

  async function regroupTabs() {
    setStatus('Extract by domain…', 'info', 0);
    const res = await callSw({ action: 'regroup_by_domain' });
    if (res.ok) {
      setStatus(`Extract by domain: ${res.windows} window(s).`, 'success');
      refreshUndoButton();
      setTimeout(updateStats, 600);
    } else if (res.error === 'no web tabs to split') {
      setStatus('No web tabs to split (internal pages are skipped).', 'info');
    } else {
      setStatus('Extract by domain failed.', 'error');
    }
  }

  async function extractCurrentDomain() {
    setStatus('Collecting current domain…', 'info', 0);
    const activeTabId = await getActiveTabId();
    const res = await callSw({ action: 'extract_current_domain', activeTabId });
    if (res.ok) {
      setStatus(`Moved ${res.count} tab(s) for ${res.domain}.`, 'success');
      refreshUndoButton();
      updateStats();
    } else if (res.error === 'active tab is not a normal web page') {
      setStatus('Open a normal web page in a tab first.', 'error');
    } else if (res.error === 'no matching tabs') {
      setStatus('No matching tabs.', 'error');
    } else {
      setStatus('Extract this domain failed.', 'error');
    }
  }

  async function performCloseThisDomain() {
    setStatus('Closing current domain…', 'info', 0);
    const activeTabId = await getActiveTabId();
    const res = await callSw({ action: 'close_this_domain', activeTabId });
    if (res.ok) {
      setStatus(`Closed ${res.count} tab(s) for ${res.domain}.`, 'success');
      refreshDailyStatsLine();
      refreshUndoButton();
      updateStats();
    } else if (res.error === 'active tab is not a normal web page') {
      setStatus('Open a normal web page in a tab first.', 'error');
    } else if (res.error === 'no matching tabs') {
      setStatus('No matching tabs.', 'error');
    } else {
      setStatus('Close domain failed.', 'error');
    }
  }

  async function groupByDomainTabGroups() {
    setStatus('Creating tab groups…', 'info', 0);
    const res = await callSw({ action: 'group_by_domain_tab_groups' });
    if (res.ok) {
      setStatus(
        res.groups
          ? `Created ${res.groups} group(s).`
          : 'Nothing to group (need 2+ tabs per site).',
        'success'
      );
    } else if (res.error === 'no tabs in this window') {
      setStatus('No tabs in this window.', 'error');
    } else {
      setStatus('Tab groups failed (check Chrome tab groups support).', 'error');
    }
  }

  async function performRemoveDuplicates() {
    setStatus('Scanning duplicates…', 'info', 0);
    const res = await callSw({ action: 'remove_duplicates' });
    if (res.ok) {
      if (res.count > 0) {
        setStatus(`Closed ${res.count} duplicate tab(s).`, 'success');
        refreshDailyStatsLine();
        refreshUndoButton();
      } else {
        setStatus('No duplicate URLs.', 'info');
      }
      updateStats();
    } else {
      setStatus('Duplicate cleanup failed.', 'error');
    }
  }

  function matchTabsForExtractString(tabs, needleRaw) {
    const needle = (needleRaw || '').trim().toLowerCase();
    if (!needle) {
      return [];
    }
    return tabs.filter(
      (t) =>
        (t.title && t.title.toLowerCase().includes(needle)) ||
        (t.url && t.url.toLowerCase().includes(needle))
    );
  }

  let extractMatchTimer;
  async function getExtractSearchPreviewHead() {
    const q = elements.extractString?.value?.trim() ?? '';
    if (!q) {
      return 'Type a search string to see match count.';
    }
    const allTabs = await getAllTabsAllWindows();
    const n = matchTabsForExtractString(allTabs, q).length;
    return n === 0 ? 'No tabs match this search right now.' : `${n} matching tab(s) would move.`;
  }

  async function refreshExtractMatchCount() {
    const line = elements.extractMatchLine;
    const input = elements.extractString;
    if (!line) {
      return;
    }
    const q = input?.value?.trim() ?? '';
    if (!q) {
      line.textContent = '';
      line.removeAttribute('data-state');
      if (elements.extractTabs) {
        cacheTitleBase(elements.extractTabs);
        elements.extractTabs.setAttribute(
          'title',
          withTitleBase(elements.extractTabs, await getExtractSearchPreviewHead())
        );
      }
      return;
    }
    try {
      const allTabs = await getAllTabsAllWindows();
      const n = matchTabsForExtractString(allTabs, q).length;
      line.textContent = n === 1 ? '1 tab matches' : `${n} tabs match`;
      line.dataset.state = n > 0 ? 'ready' : 'empty';
      if (elements.extractTabs) {
        cacheTitleBase(elements.extractTabs);
        elements.extractTabs.setAttribute(
          'title',
          withTitleBase(elements.extractTabs, await getExtractSearchPreviewHead())
        );
      }
    } catch (e) {
      console.warn(e);
      line.textContent = '';
      line.removeAttribute('data-state');
    }
  }

  function scheduleExtractMatchCount() {
    clearTimeout(extractMatchTimer);
    extractMatchTimer = setTimeout(() => {
      refreshExtractMatchCount();
    }, 160);
  }

  async function extractTabs() {
    const q = elements.extractString?.value?.trim();
    if (!q) {
      setStatus('Type a search string.', 'error');
      return;
    }
    setStatus('Extracting…', 'info', 0);
    const res = await callSw({ action: 'extract_by_string', needle: q });
    if (res.ok) {
      if (elements.extractString) {elements.extractString.value = '';}
      refreshExtractMatchCount();
      setStatus(`Extracted ${res.count} tab(s).`, 'success');
      refreshUndoButton();
      updateStats();
    } else if (res.error === 'no matches') {
      setStatus('No matches.', 'error');
    } else {
      setStatus('Extract failed.', 'error');
    }
  }

  async function muteAllTabs() {
    try {
      setStatus('Muting tabs…', 'info', 0);
      const tabs = await chrome.tabs.query({});
      let n = 0;
      for (const tab of tabs) {
        try {
          if (!tab.mutedInfo?.muted) {
            await chrome.tabs.update(tab.id, { muted: true });
            n++;
          }
        } catch {
          /* ignore */
        }
      }
      setStatus(n ? `Muted ${n} tab(s).` : 'Tabs already muted.', 'success');
    } catch {
      setStatus('Mute failed.', 'error');
    }
  }

  async function buildSessionExport() {
    const tabs = await getAllTabsAllWindows();
    const windowsData = {};
    for (const tab of tabs) {
      if (!windowsData[tab.windowId]) {windowsData[tab.windowId] = [];}
      windowsData[tab.windowId].push(tab.url || '');
    }
    return {
      windowsData,
      tabCount: tabs.length,
      windowCount: Object.keys(windowsData).length,
    };
  }

  /**
   * Envelope v2: metadata and data live in separate keys so future metadata
   * additions can't accidentally collide with a stringified windowId.
   * Loader accepts both v1 (siblings) and v2 (`windows` key) — see
   * extractWindowsDataFromFileJson.
   */
  function buildSessionFileEnvelope(windowsData) {
    return {
      _altTabExport: {
        formatVersion: ALT_TAB_SESSION_FILE_VERSION,
        savedAt: new Date().toISOString(),
      },
      windows: windowsData,
    };
  }

  function downloadSessionJson(windowsData, fileName) {
    const envelope = buildSessionFileEnvelope(windowsData);
    const fileContent = JSON.stringify(envelope, null, 2);
    const blob = new Blob([fileContent], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function saveTabs() {
    try {
      const { windowsData, tabCount } = await buildSessionExport();
      const fileName = `alt_tab_session_${formatDateForFilename()}.json`;
      downloadSessionJson(windowsData, fileName);
      setStatus(`Saved ${tabCount} tab(s).`, 'success');
    } catch {
      setStatus('Save failed.', 'error');
    }
  }

  /**
   * Pull `{<windowId>: [url, ...]}` out of a loaded session file, accepting
   * both envelope shapes:
   *   v2: { _altTabExport, windows: { [id]: [url,...] } }
   *   v1: { _altTabExport, [id]: [url,...], [id]: [url,...] }   (legacy)
   * Preset snapshots already have the v1-like shape (no envelope), so the
   * v1 path also covers them.
   */
  function extractWindowsDataFromFileJson(json) {
    if (json.windows && typeof json.windows === 'object') {
      const out = {};
      for (const [key, value] of Object.entries(json.windows)) {
        if (Array.isArray(value) && value.length) {
          out[key] = value;
        }
      }
      return out;
    }
    const out = {};
    for (const [key, value] of Object.entries(json)) {
      if (Array.isArray(value) && value.length) {
        out[key] = value;
      }
    }
    return out;
  }

  async function restoreSessionViaSw(mode, windowsData) {
    const res = await callSw({
      action: 'restore_session',
      mode,
      windowsData,
    });
    if (res.ok) {
      const verb = mode === 'append' ? 'Appended' : 'Loaded';
      const skippedSuffix = res.skipped > 0 ? `; skipped ${res.skipped} non-http` : '';
      setStatus(
        `${verb} ${res.tabCount} tab(s) in ${res.windowCount} window(s)${skippedSuffix}.`,
        'success'
      );
      refreshUndoButton();
      updateStats();
    } else if (res.error === 'no valid http(s) URLs') {
      setStatus('No valid http(s) URLs in session.', 'error');
    } else {
      setStatus('Restore failed.', 'error');
    }
    return res;
  }

  async function loadTabsFromFile(append) {
    const file = elements.fileInput?.files?.[0];
    if (!file) {return;}

    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const json = JSON.parse(event.target.result);
        if (typeof json !== 'object' || json === null) {throw new Error('bad json');}
        const fmt = json._altTabExport?.formatVersion;
        if (typeof fmt === 'number' && fmt > ALT_TAB_SESSION_FILE_VERSION) {
          console.warn('Session file formatVersion', fmt, '> supported', ALT_TAB_SESSION_FILE_VERSION);
          setStatus(`Warning: session is v${fmt}, extension supports v${ALT_TAB_SESSION_FILE_VERSION}.`, 'info', 5000);
        }
        const windowsData = extractWindowsDataFromFileJson(json);
        setStatus(append ? 'Appending…' : 'Loading…', 'info', 0);
        await restoreSessionViaSw(append ? 'append' : 'replace', windowsData);
      } catch (e) {
        console.warn(e);
        setStatus('Invalid or unsupported JSON.', 'error');
      }
      if (elements.fileInput) {elements.fileInput.value = '';}
    };
    reader.readAsText(file);
  }

  async function getPresetSlot(slotIndex) {
    const key = PRESET_SLOT_KEYS[slotIndex];
    const got = await storageLocalGet(key);
    const raw = got[key];
    if (raw && typeof raw === 'object' && (raw.j || raw.jp?.length || raw.windowsDataJson)) {
      const wd = parseWindowsDataFromPresetRaw(raw);
      if (!wd || typeof wd !== 'object') {
        return null;
      }
      const windowCount =
        typeof raw.windowCount === 'number'
          ? raw.windowCount
          : Object.keys(wd).length;
      const tabCount =
        typeof raw.tabCount === 'number'
          ? raw.tabCount
          : Object.values(wd).reduce(
            (a, urls) => a + (Array.isArray(urls) ? urls.length : 0),
            0
          );
      return {
        windowsData: wd,
        tabCount,
        windowCount,
        savedAt: raw.savedAt,
      };
    }
    return null;
  }

  /**
   * Move all slots out of the legacy `sessionPresetSlotsV1` array key into
   * per-slot keys, then delete the legacy key. Runs once on popup open;
   * idempotent — becomes a no-op once migrated.
   */
  async function migrateLegacyPresetsOnce() {
    const got = await storageLocalGet(PRESET_STORAGE_KEY);
    const arr = got[PRESET_STORAGE_KEY];
    if (!Array.isArray(arr)) {return;}
    for (let i = 0; i < PRESET_SLOT_KEYS.length; i++) {
      const leg = arr[i];
      if (!leg?.windowsData) {continue;}
      const wd = leg.windowsData;
      const windowCount =
        typeof leg.windowCount === 'number' ? leg.windowCount : Object.keys(wd).length;
      const tabCount =
        typeof leg.tabCount === 'number'
          ? leg.tabCount
          : Object.values(wd).reduce((a, urls) => a + (Array.isArray(urls) ? urls.length : 0), 0);
      try {
        const payload = buildPresetStoragePayload(
          wd,
          tabCount,
          windowCount,
          typeof leg.savedAt === 'number' ? leg.savedAt : Date.now()
        );
        await storageLocalSet({ [PRESET_SLOT_KEYS[i]]: payload });
      } catch (e) {
        console.warn('preset legacy migrate slot', i, e);
        return;
      }
    }
    try {
      await storageLocalRemove(PRESET_STORAGE_KEY);
    } catch (e) {
      console.warn('preset legacy key cleanup', e);
    }
  }

  async function holdPreset(slotIndex) {
    try {
      const n = slotIndex + 1;
      setStatus(`Saving snapshot (Hold ${n})…`, 'info', 0);
      const { windowsData, tabCount, windowCount } = await buildSessionExport();
      const payload = buildPresetStoragePayload(
        windowsData,
        tabCount,
        windowCount,
        Date.now()
      );
      await storageLocalSet({ [PRESET_SLOT_KEYS[slotIndex]]: payload });
      setStatus(
        `Hold ${n}: full-session snapshot saved (${tabCount} tabs · ${windowCount} windows).`,
        'success'
      );
      updateStats();
    } catch (e) {
      console.warn('holdPreset', e);
      const msg = String(e?.message || e);
      const short = msg.length > 140 ? `${msg.slice(0, 137)}…` : msg;
      if (/quota|QUOTA|maximum|exceed/i.test(msg)) {
        setStatus(ALT_TAB_STORAGE_QUOTA_HINT, 'error');
      } else {
        setStatus(`Could not save snapshot: ${short}`, 'error');
      }
    }
  }

  async function fetchPreset(slotIndex) {
    const n = slotIndex + 1;
    const slot = await getPresetSlot(slotIndex);
    if (!slot?.windowsData) {
      setStatus(`Hold ${n} has no snapshot — use Hold ${n} first.`, 'error');
      return;
    }
    setStatus(`Loading snapshot (Fetch ${n})…`, 'info', 0);
    await restoreSessionViaSw('replace', slot.windowsData);
  }

  /**
   * Two-step confirm button. First click flips label to `confirm` for `ms` ms;
   * second click (while armed) invokes `onConfirm`. Moving the mouse off the
   * button cancels arming. `preArm()` lets the caller veto arming (e.g. bail
   * on a restricted page) — return false to keep the button idle.
   */
  function makeArmedButton(el, { label, confirm, onConfirm, preArm, ms = 2000 }) {
    if (!el) {return { reset() {}, isArmed: () => false };}
    let armed = false;
    let timer = null;
    const reset = () => {
      armed = false;
      if (timer) {clearTimeout(timer); timer = null;}
      el.textContent = label;
      el.removeAttribute('data-armed');
    };
    const arm = () => {
      armed = true;
      el.textContent = confirm;
      el.setAttribute('data-armed', 'true');
      if (timer) {clearTimeout(timer);}
      timer = setTimeout(reset, ms);
    };
    el.addEventListener('click', async () => {
      if (!armed) {
        if (preArm && (await preArm()) === false) {return;}
        arm();
        return;
      }
      reset();
      await onConfirm();
    });
    el.addEventListener('mouseleave', () => { if (armed) {reset();} });
    return { reset, isArmed: () => armed };
  }

  async function executeDeleteAllTabs() {
    try {
      setStatus('Saving backup…', 'info', 0);
      const { windowsData } = await buildSessionExport();
      const backupName = `alt_tab_before_delete_${formatDateForFilename()}.json`;
      downloadSessionJson(windowsData, backupName);
    } catch (e) {
      console.warn('backup before delete', e);
      setStatus('Backup failed — aborting.', 'error');
      return;
    }
    setStatus('Closing…', 'info', 0);
    const res = await callSw({ action: 'delete_all_tabs', defaultUrl: DEFAULT_URL });
    if (res.ok) {
      setStatus(`Backup saved — closed ${res.count} tab(s).`, 'success');
      refreshUndoButton();
      updateStats();
    } else {
      setStatus('Could not close tabs.', 'error');
    }
  }

  async function countDuplicateTabsToClose() {
    const res = await callSw({ action: 'count_duplicates' });
    return res.ok ? res.count : 0;
  }

  function cacheTitleBase(el) {
    if (!el) {
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(el.dataset, 'titleBase')) {
      el.dataset.titleBase = el.getAttribute('title') || '';
    }
  }

  function withTitleBase(el, headLine) {
    const b = el.dataset.titleBase || '';
    return b ? `${headLine}\n${b}` : headLine;
  }

  function bindHoverTooltip(el, computeHead) {
    cacheTitleBase(el);
    if (!el) {
      return;
    }
    let gen = 0;
    const refresh = async () => {
      const id = ++gen;
      try {
        const head = await computeHead();
        if (id !== gen) {
          return;
        }
        el.setAttribute('title', withTitleBase(el, head));
      } catch (e) {
        console.warn('hover tooltip', e);
        if (id === gen) {
          el.setAttribute('title', el.dataset.titleBase || '');
        }
      }
    };
    el.addEventListener('pointerenter', refresh);
    el.addEventListener('focusin', refresh);
  }

  function setupDynamicHoverTitles() {
    bindHoverTooltip(elements.closeThisDomain, async () => {
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!active?.url || isRestrictedUrl(active.url)) {
        return 'Active tab must be a normal web page.';
      }
      const domain = getDomainFromUrl(active.url);
      if (!domain) {
        return 'Could not read domain from the active tab.';
      }
      const allTabs = await getAllTabsAllWindows();
      let n = 0;
      for (const t of allTabs) {
        if (!t.url || isRestrictedUrl(t.url)) {
          continue;
        }
        if (getDomainFromUrl(t.url) === domain) {
          n++;
        }
      }
      return n === 0 ? 'No matching tabs.' : `Would close ${n} tab(s) on ${domain}.`;
    });

    bindHoverTooltip(elements.removeDuplicates, async () => {
      const n = await countDuplicateTabsToClose();
      return n === 0 ? 'No duplicate URLs right now.' : `Would close ${n} duplicate tab(s).`;
    });

    bindHoverTooltip(elements.extractDomain, async () => {
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!active?.url || isRestrictedUrl(active.url)) {
        return 'Active tab must be a normal web page.';
      }
      const domain = getDomainFromUrl(active.url);
      if (!domain) {
        return 'Could not read domain from the active tab.';
      }
      const allTabs = await getAllTabsAllWindows();
      let n = 0;
      for (const t of allTabs) {
        if (!t.url || isRestrictedUrl(t.url)) {
          continue;
        }
        if (getDomainFromUrl(t.url) === domain) {
          n++;
        }
      }
      return `${n} tab(s) on ${domain} would move.`;
    });

    bindHoverTooltip(elements.extractTabs, getExtractSearchPreviewHead);

    bindHoverTooltip(elements.mergeWindows, async () => {
      const current = await chrome.windows.getCurrent();
      const normal = await getNormalWindowsCached();
      if (normal.length <= 1) {
        return 'Only one window — nothing to merge.';
      }
      let tabsToMove = 0;
      for (const w of normal) {
        if (w.id !== current.id) {
          tabsToMove += w.tabs.length;
        }
      }
      const ow = normal.length - 1;
      return `Would move ${tabsToMove} tab(s) from ${ow} other window(s).`;
    });

    bindHoverTooltip(elements.groupTabGroups, async () => {
      const current = await chrome.windows.getCurrent({ populate: true });
      if (current.type !== 'normal' || !current.tabs?.length) {
        return 'No tabs in this window.';
      }
      const byDomain = {};
      for (const tab of current.tabs) {
        if (!tab.url || isRestrictedUrl(tab.url)) {
          continue;
        }
        const d = getDomainFromUrl(tab.url);
        if (!d) {
          continue;
        }
        if (!byDomain[d]) {
          byDomain[d] = 0;
        }
        byDomain[d]++;
      }
      let groups = 0;
      for (const d of Object.keys(byDomain)) {
        if (byDomain[d] >= 2) {
          groups++;
        }
      }
      return groups === 0
        ? 'No domain with two or more http(s) tabs here.'
        : `Would create ${groups} tab group(s) in this window.`;
    });

    bindHoverTooltip(elements.regroupTabs, async () => {
      const windows = await getNormalWindowsCached();
      const allTabs = windows.flatMap((w) => w.tabs);
      const tabsByHostname = {};
      for (const tab of allTabs) {
        if (tab.url && !isRestrictedUrl(tab.url)) {
          const hostname = getDomainFromUrl(tab.url);
          if (!hostname) {
            continue;
          }
          if (!tabsByHostname[hostname]) {
            tabsByHostname[hostname] = [];
          }
          tabsByHostname[hostname].push(tab);
        }
      }
      let domains3 = 0;
      let tabsIn = 0;
      for (const h of Object.keys(tabsByHostname)) {
        const g = tabsByHostname[h];
        if (g.length >= 3) {
          domains3++;
          tabsIn += g.length;
        }
      }
      if (domains3 === 0) {
        return 'No site has three or more tabs yet.';
      }
      return `${domains3} domain(s) with 3+ tabs (${tabsIn} tabs involved).`;
    });

    bindHoverTooltip(elements.muteAllBtn, async () => {
      const tabs = await chrome.tabs.query({});
      let n = 0;
      for (const t of tabs) {
        if (!t.mutedInfo?.muted) {
          n++;
        }
      }
      return n === 0 ? 'All tabs are already muted.' : `Would mute ${n} unmuted tab(s).`;
    });

    bindHoverTooltip(elements.saveTabs, async () => {
      const tabs = await getAllTabsAllWindows();
      const wins = new Set(tabs.map((t) => t.windowId)).size;
      return `Export includes ${tabs.length} tab(s) in ${wins} window(s).`;
    });

    bindHoverTooltip(elements.closeTabs, async () => {
      const tabs = await getAllTabsAllWindows();
      return `Would close ${tabs.length} tab(s) after backup download.`;
    });

    for (let i = 0; i < 4; i++) {
      const num = i + 1;
      bindHoverTooltip(elements.presetHold[i], async () => {
        const tabs = await getAllTabsAllWindows();
        const wins = new Set(tabs.map((t) => t.windowId)).size;
        const slot = await getPresetSlot(i);
        const cur = `${tabs.length} tab(s) · ${wins} window(s)`;
        if (!slot) {
          return `Save full-session snapshot from now: ${cur}\nHold ${num} slot is empty`;
        }
        const age =
          typeof slot.savedAt === 'number' ? ` · ${formatRelativeTime(slot.savedAt)}` : '';
        return `Save snapshot — current: ${cur}\nHold ${num} has: ${slot.tabCount} tab(s) · ${slot.windowCount} window(s)${age}`;
      });
      bindHoverTooltip(elements.presetFetch[i], async () => {
        const slot = await getPresetSlot(i);
        if (!slot) {
          return `No snapshot in Hold ${num} — save with Hold ${num} first`;
        }
        const age =
          typeof slot.savedAt === 'number'
            ? `\nSnapshot from ${formatRelativeTime(slot.savedAt)}`
            : '';
        return `Restore full session from snapshot: ${slot.tabCount} tab(s) · ${slot.windowCount} window(s)${age}`;
      });
    }
  }

  /**
   * Copy every tab across every window as a markdown list, grouped by window.
   * Popups often close mid-clipboard-write; we await navigator.clipboard.writeText
   * synchronously after the button click so it completes before the popup dies.
   */
  async function copyAllAsMarkdown() {
    try {
      const tabs = await getAllTabsAllWindows();
      if (tabs.length === 0) {
        setStatus('No tabs to copy.', 'info');
        return;
      }
      const byWindow = new Map();
      for (const tab of tabs) {
        if (!byWindow.has(tab.windowId)) {byWindow.set(tab.windowId, []);}
        byWindow.get(tab.windowId).push(tab);
      }
      const lines = [];
      let idx = 1;
      for (const group of byWindow.values()) {
        lines.push(`## Window ${idx++} (${group.length} tab${group.length === 1 ? '' : 's'})`);
        for (const t of group) {
          const title = (t.title || t.url || '').replace(/\[|\]/g, (m) => `\\${m}`);
          lines.push(`- [${title}](${t.url || ''})`);
        }
        lines.push('');
      }
      const md = lines.join('\n').trimEnd();
      await navigator.clipboard.writeText(md);
      setStatus(`Copied ${tabs.length} tab(s) as markdown.`, 'success');
    } catch (e) {
      console.warn('copyAllAsMarkdown', e);
      setStatus('Copy failed (clipboard blocked).', 'error');
    }
  }

  /* ——— Jump: fuzzy-search any tab across all windows and focus it ——— */

  const JUMP_MAX_RESULTS = 10;
  let jumpMatches = [];
  let jumpSelectedIndex = -1;
  let jumpRenderToken = 0;

  function renderJumpResults() {
    const ul = elements.jumpResults;
    if (!ul) {return;}
    if (jumpMatches.length === 0) {
      ul.hidden = true;
      ul.innerHTML = '';
      return;
    }
    ul.hidden = false;
    const frag = document.createDocumentFragment();
    jumpMatches.forEach((tab, i) => {
      const li = document.createElement('li');
      li.className = 'jump-item';
      li.setAttribute('role', 'option');
      li.dataset.idx = String(i);
      if (i === jumpSelectedIndex) {li.setAttribute('aria-selected', 'true');}
      const titleDiv = document.createElement('div');
      titleDiv.className = 'jump-item-title';
      titleDiv.textContent = tab.title || tab.url || '(no title)';
      const metaDiv = document.createElement('div');
      metaDiv.className = 'jump-item-meta';
      const domainSpan = document.createElement('span');
      domainSpan.className = 'jump-item-domain';
      domainSpan.textContent = getDomainFromUrl(tab.url) || tab.url || '';
      metaDiv.appendChild(domainSpan);
      li.appendChild(titleDiv);
      li.appendChild(metaDiv);
      frag.appendChild(li);
    });
    ul.replaceChildren(frag);
  }

  async function refreshJumpResults() {
    const q = elements.jumpQuery?.value?.trim() ?? '';
    const token = ++jumpRenderToken;
    if (!q) {
      jumpMatches = [];
      jumpSelectedIndex = -1;
      renderJumpResults();
      return;
    }
    const all = await getAllTabsAllWindows();
    if (token !== jumpRenderToken) {return;}
    jumpMatches = matchTabsForExtractString(all, q).slice(0, JUMP_MAX_RESULTS);
    jumpSelectedIndex = jumpMatches.length ? 0 : -1;
    renderJumpResults();
  }

  async function jumpToTab(tab) {
    if (!tab) {return;}
    try {
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      window.close();
    } catch (e) {
      console.warn('jumpToTab', e);
      setStatus('Could not focus that tab.', 'error');
    }
  }

  function moveJumpSelection(delta) {
    if (jumpMatches.length === 0) {return;}
    jumpSelectedIndex =
      (jumpSelectedIndex + delta + jumpMatches.length) % jumpMatches.length;
    renderJumpResults();
    const active = elements.jumpResults?.querySelector('[aria-selected="true"]');
    active?.scrollIntoView({ block: 'nearest' });
  }

  function setupEventListeners() {
    elements.themeToggle?.addEventListener('click', () => cycleTheme());
    elements.undoBtn?.addEventListener('click', performUndo);

    elements.sortTabs?.addEventListener('click', () => sortTabs('sort_by_name'));
    elements.sortTabsByDomain?.addEventListener('click', () => sortTabs('sort_by_domain'));
    elements.sortTabsLastVisited?.addEventListener('click', () => sortTabs('sort_by_last_visit'));
    elements.sortTabsCreated?.addEventListener('click', () => sortTabs('sort_by_creation_time'));

    elements.mergeWindows?.addEventListener('click', mergeAllWindows);
    elements.regroupTabs?.addEventListener('click', regroupTabs);
    elements.extractDomain?.addEventListener('click', extractCurrentDomain);
    elements.groupTabGroups?.addEventListener('click', groupByDomainTabGroups);

    makeArmedButton(elements.closeThisDomain, {
      label: 'Close this domain',
      confirm: 'Sure?',
      onConfirm: performCloseThisDomain,
      preArm: async () => {
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!active?.url || isRestrictedUrl(active.url)) {
          setStatus('Open a normal web page in a tab first.', 'error');
          return false;
        }
        if (!getDomainFromUrl(active.url)) {
          setStatus('Could not read domain.', 'error');
          return false;
        }
        return true;
      },
    });
    elements.muteAllBtn?.addEventListener('click', muteAllTabs);
    makeArmedButton(elements.removeDuplicates, {
      label: 'Close duplicate URLs',
      confirm: 'Sure?',
      onConfirm: performRemoveDuplicates,
    });
    elements.extractTabs?.addEventListener('click', extractTabs);
    elements.extractString?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {extractTabs();}
    });
    elements.extractString?.addEventListener('input', scheduleExtractMatchCount);

    elements.saveTabs?.addEventListener('click', saveTabs);
    let pendingAppend = false;
    elements.loadTabs?.addEventListener('click', () => {
      pendingAppend = false;
      elements.fileInput?.click();
    });
    elements.appendTabs?.addEventListener('click', () => {
      pendingAppend = true;
      elements.fileInput?.click();
    });
    elements.copyMd?.addEventListener('click', copyAllAsMarkdown);

    elements.jumpQuery?.addEventListener('input', refreshJumpResults);
    elements.jumpQuery?.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveJumpSelection(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveJumpSelection(-1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (jumpSelectedIndex >= 0) {
          jumpToTab(jumpMatches[jumpSelectedIndex]);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        if (elements.jumpQuery.value) {
          elements.jumpQuery.value = '';
          refreshJumpResults();
        } else {
          window.close();
        }
      }
    });
    elements.jumpResults?.addEventListener('click', (e) => {
      const li = e.target.closest('.jump-item');
      if (!li) {return;}
      const idx = Number(li.dataset.idx);
      if (Number.isFinite(idx) && jumpMatches[idx]) {
        jumpToTab(jumpMatches[idx]);
      }
    });

    elements.fileInput?.addEventListener('change', () => {
      const append = pendingAppend;
      pendingAppend = false;
      loadTabsFromFile(append);
    });

    makeArmedButton(elements.closeTabs, {
      label: 'Delete',
      confirm: 'Sure?',
      onConfirm: executeDeleteAllTabs,
    });

    for (let i = 0; i < 4; i++) {
      elements.presetHold[i]?.addEventListener('click', () => holdPreset(i));
      elements.presetFetch[i]?.addEventListener('click', () => fetchPreset(i));
    }

    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        elements.jumpQuery?.focus();
        elements.jumpQuery?.select();
      }
    });

    setupDynamicHoverTitles();
  }

  setupEventListeners();
  try {
    await applyThemeFromStorage();
  } catch (e) {
    console.warn('applyThemeFromStorage', e);
  }
  void migrateLegacyPresetsOnce();
  await updateStats();
  await refreshDailyStatsLine();
  void refreshExtractMatchCount();
  void refreshUndoButton();
  elements.jumpQuery?.focus();
  setStatus('Ready.', 'info', 2000);
});
