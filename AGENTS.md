# AGENTS.md — Alt Tab (Chrome MV3) dataflow & codepaths

## Files

```
alt_tab/
├── manifest.json        MV3 manifest, permissions, commands
├── background.js        Service worker — ALL multi-step window/tab ops + Undo + Silence
├── popup.html           Browser-action popup DOM
├── popup.css            Design tokens + button variants (system/dark/light themes)
├── popup_working.js     Popup layer: thin wrapper around chrome.runtime.sendMessage → SW
└── icon{16,32,48,128}.png
```

## Design rule

**Popup is thin.** Any op that does `windows.create` more than once OR `create + move` OR
multi-step restore MUST live in SW — popup dies on focus loss. Popup only does:
  - read-only listings (tooltips, stats, jump search) — memoised in a 1s cache;
  - local UI state (arming, theme cycle, pendingAppend toggle);
  - one-hop sends via `callSw({action, ...})` (invalidates the windows cache after every reply).

SW exposes a single message handler with `HANDLERS` dispatch and universal wrapper that:
  1. captures Undo snapshot for every UNDOABLE action;
  2. executes handler;
  3. returns `{ok: true, ...}` or `{ok: false, error: string}`.

## Top-level dataflow

```
┌──────────┐  Ctrl+Shift+1..4 (global) ┌──────────────┐
│ Keyboard │ ─────────────────────────▶│ chrome.commands│
└──────────┘                           └──────┬────────┘
                                              ▼
┌──────────┐  click / Ctrl+K         ┌──────────────┐
│ popup.js │ ────────────────────────▶│ background.js│ ← the only place
└─────┬────┘  sendMessage({action})  │ (SW)         │   that mutates tabs
      │                              │              │
      ▼                              │              │─▶ chrome.tabs.*
 popup.css                           │              │─▶ chrome.windows.*
                                     │              │─▶ chrome.tabGroups.*
                                     │              │─▶ chrome.scripting (pause media)
                                     │              │─▶ chrome.storage.local
                                     └──────────────┘
```

## Codepath: Sort (global OR popup) — OK

```
Path A: Ctrl+Shift+1..4 (global shortcut)
  → chrome.commands onCommand
  → background.sortTabs(command)

Path B: popup button click
  → callSw({action:'sort', sortType})
  → HANDLERS.sort(req) → sortTabs(sortType)

(popup keydown path removed — used to duplicate Path A when popup open.)
```

## Codepath: Session Save — OK

```
click "Save"
  → buildSessionExport() → { windowsData, tabCount, windowCount }
  → downloadSessionJson(windowsData, filename)
     → buildSessionFileEnvelope() → { _altTabExport:{formatVersion:2, savedAt}, windows: {...} }
     → JSON.stringify → Blob → <a download>
```

Loader accepts both v1 (siblings) and v2 (`windows` key) envelope shapes.

## Codepath: Session Load / Replace — OK

```
click "Load" → file picker → FileReader
  → JSON.parse → formatVersion check (warn if > supported)
  → extractWindowsDataFromFileJson (v1 siblings OR v2 windows key)
  → callSw({action:'restore_session', mode:'replace', windowsData})
       │
       ▼  (SW)
     captureUndoSnapshot('session restore')
     restoreSession('replace', windowsData):
       skipped = count non-http URLs dropped
       groups = valid-http groups
       close every other normal window
       remove all curTabs except pivot curTabs[0]
       update pivot.url → firstUrls[0], active:true
       for firstUrls[1..]: tabs.create(active:false)
       for groups[1..]: windows.create({url: groupUrls, focused:false})
       muteTabs + markPendingPause on all created ids
       windows.update(lastWinId, focused:true)
       return { ok, tabCount, windowCount, skipped }
  → popup sets "Loaded N tab(s) in M window(s); skipped K non-http."
```

## Codepath: Session Append — OK

```
callSw({action:'restore_session', mode:'append', windowsData})
  → restoreSession('append'):
      for each group:
        windows.create({url: urls, focused:false, state:'normal'})
      silenceTabs(all created)
      windows.update(lastWinId, focused:true)
      return { ok, tabCount, windowCount, skipped }
```

## Codepath: Hold/Fetch (preset snapshots) — OK

```
Hold N:
  → buildSessionExport() → { windowsData, tabCount, windowCount } [popup]
  → buildPresetStoragePayload → chunk if > 600 KB
  → storage.local.set({altTabPresetSlotN})

Fetch N:
  → getPresetSlot(n) [popup]
  → callSw({action:'restore_session', mode:'replace', windowsData})

On popup open: migrateLegacyPresetsOnce()
  → reads sessionPresetSlotsV1 array
  → writes each slot to altTabPresetSlotN
  → removes sessionPresetSlotsV1 (was never cleaned up before)
```

## Codepath: Regroup by domain — OK (no auto-silence)

```
callSw({action:'regroup_by_domain'})
  → captureUndoSnapshot('regroup by domain')
  → regroupByDomain():
      getAllTabsFlat → bucket by hostname (skip restricted)
      big = groups.length ≥ 3, rest → 'misc' group
      for each group:
        moveTabsToNewWindow(group)
          [first: windows.create({tabId}) → rest: tabs.move]
```
`moveTabsToNewWindow` no longer silences moved tabs — media keeps playing.

## Codepath: Extract current domain / by string — OK

```
popup getActiveTabId() → activeTabId (chrome.tabs.query currentWindow:true)
callSw({action:'extract_current_domain', activeTabId})
  OR
callSw({action:'extract_by_string', needle})
  → resolveActiveTab(activeTabId) | match by title/url substring
  → moveTabsToNewWindow(matching)  ← does NOT mute
```

## Codepath: Merge all windows — OK (pinned preserved)

```
callSw({action:'merge_all_windows'})
  → captureUndoSnapshot('merge all windows')
  → mergeAllWindows():
      current = windows.getCurrent
      pinnedIds = collect t.id where t.pinned && w !== current
      for each other window: tabs.move(ids, target) then windows.remove
      for each pinnedId: tabs.update(id, {pinned:true})  ← restore pin state
      windows.update(target, focused:true)
```

## Codepath: Close this domain / Remove duplicates — OK

Two-step armed confirm via `makeArmedButton` factory (label/confirm/ms/preArm/onConfirm).
```
popup: arming UI → second click → callSw({action:'close_this_domain' | 'remove_duplicates'})
  → captureUndoSnapshot
  → tabs.remove(matching)
  → bumpDailyCloseStats
```
`removeDuplicates` / `countDuplicates` use `getAllTabsFlat()` — normal windows only.

## Codepath: Delete all tabs — OK

Two-step armed confirm (same factory).
```
popup: arm → confirm → buildSessionExport + downloadSessionJson (auto-backup)
  → callSw({action:'delete_all_tabs', defaultUrl})
     → tabs.create({url: newtab, active:true})
     → tabs.remove(beforeIds)
```

## Codepath: Undo (with redo toggle) — NEW

```
1) Any UNDOABLE action:
   handler wrapper → captureUndoSnapshot('<label>') → handler runs → response.
   Undo slot now holds pre-op windowsData.

2) popup opens → refreshUndoButton()
   → callSw({action:'get_undo_info'})
   → header button label "Undo <label>", tooltip shows counts + age.

3) Click Undo button
   → callSw({action:'undo'})
      → readUndoSnapshot → captureUndoSnapshot('redo <prev label>')  ← NEW
      → restoreSession('replace', snap.windowsData)
   → refreshUndoButton shows "Undo redo <label>", clicking again re-applies.
```

UNDOABLE_ACTIONS = restore_session, regroup_by_domain, extract_current_domain,
extract_by_string, merge_all_windows, close_this_domain, remove_duplicates, delete_all_tabs.

## Codepath: Silence (mute + pause) — scoped to Session Restore only

```
silenceTabs(ids):   // used only in restoreSession(append)
  muteTabs(ids) → chrome.tabs.update(id, {muted:true}) × N
  pauseMediaInTab(id) for every id → scripting.executeScript(pause video/audio)
  markPendingPause(ids) → stored in altTabPendingPauseIds

restoreSession(replace):
  muteTabs + markPendingPause (no synchronous pause — URLs not loaded yet)

tabs.onUpdated(status:'complete'):
  consumePendingPause(tabId) → if hit, pauseMediaInTab(tabId) again
```

`moveTabsToNewWindow` (extract, regroup, extract-by-string) no longer silences.

## Codepath: Jump (Ctrl+K) — OK

```
popup Ctrl+K focuses jumpQuery
  → input event → refreshJumpResults (token-guarded)
  → getAllTabsAllWindows (cached) → matchTabsForExtractString(needle) → top 10
Arrow↑/↓ moveJumpSelection
Enter jumpToTab(tab) → tabs.update(active:true) → windows.update(focused:true) → window.close()
```

## Codepath: Copy MD — OK

```
copyAllAsMarkdown:
  getAllTabsAllWindows (cached) → group by windowId
  produce "## Window N (K tabs)" + "- [title](url)" list
  navigator.clipboard.writeText (awaited before popup dies)
```

## Windows cache

Popup memoises `chrome.windows.getAll({populate:true})` for 1000 ms:
- tooltips (~7 bindings) hit the cache;
- `updateStats` + `getAllTabsAllWindows` → `getNormalWindowsCached` → cache;
- `callSw()` always invalidates the cache on reply so mutations are immediately visible.

## Storage schema

```
chrome.storage.local:
  themePref               'system' | 'dark' | 'light'
  altTabDailyCloseStats   { day: 'YYYY-MM-DD', dupTabs: int, domainTabs: int }
  altTabPresetSlot0..3    { v:9, tabCount, windowCount, savedAt, j?:string, jp?:string[] }
  sessionPresetSlotsV1    LEGACY — now migrated AND removed by migrateLegacyPresetsOnce()
  altTabUndoSnapshot      { v:1, tabCount, windowCount, savedAt, label, j?|jp? }
  altTabPendingPauseIds   { [tabId]: timestamp } — onUpdated consumes these
```

## Session file schema (v2)

```json
{
  "_altTabExport": { "formatVersion": 2, "savedAt": "ISO8601" },
  "windows": {
    "<windowId1>": ["url1", ...],
    "<windowId2>": ["url1", ...]
  }
}
```

Loader also accepts v1 (envelope + window-id siblings).
`formatVersion > supported` → warning toast, load continues.

## Permissions audit (`manifest.json`)

| Permission | Used? | Where |
|---|---|---|
| `tabs` | Yes | everywhere |
| `commands` | Yes | sort shortcuts |
| `scripting` | Yes | `pauseMediaInTab` via `chrome.scripting.executeScript` |
| `storage` | Yes | themePref, stats, presets, undo snap, pendingPause |
| `tabGroups` | Yes | `groupByDomainTabGroups` |
| `<all_urls>` host | Yes | read tab URLs + scripting target |

`activeTab` permission was removed — `tabs` + `<all_urls>` already cover every use.

## See also

- `plan2.md` — full bug-hunt + 4-wave delivery report.
- `DIAGRAMS.md` — mermaid diagrams for flow + Undo redo + Silence.
