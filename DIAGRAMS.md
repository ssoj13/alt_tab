# DIAGRAMS.md — Alt Tab mermaid diagrams

## 1. High-level architecture

```mermaid
flowchart LR
  User([User])
  KBD[Keyboard<br/>Ctrl+Shift+1..4]
  Popup[popup.html + popup_working.js<br/>thin UI layer]
  SW[background.js<br/>Service Worker<br/>all destructive ops + Undo + Silence]
  ChromeTabs[(chrome.tabs)]
  ChromeWin[(chrome.windows)]
  ChromeGrp[(chrome.tabGroups)]
  ChromeScr[(chrome.scripting)]
  Storage[(chrome.storage.local)]

  User -->|click button| Popup
  User -->|shortcut| KBD
  KBD -->|chrome.commands| SW
  Popup -->|sendMessage / callSw| SW
  Popup -->|read-only queries for UI + tooltips| ChromeTabs
  Popup -->|read-only| ChromeWin
  Popup -->|themePref, dailyStats, presets, pendingPause| Storage
  SW --> ChromeTabs
  SW --> ChromeWin
  SW --> ChromeGrp
  SW --> ChromeScr
  SW --> Storage
```

## 2. Session Save / Load / Append (current)

```mermaid
sequenceDiagram
  participant U as User
  participant P as Popup
  participant SW as background.js
  participant C as chrome.*
  participant FS as Filesystem

  Note over U,P: SAVE
  U->>P: click Save
  P->>C: windows.getAll({populate:true})
  C-->>P: [windows with tabs]
  P->>P: group by tab.windowId → windowsData
  P->>FS: download JSON blob (envelope v1)

  Note over U,P: LOAD (replace)
  U->>P: click Load → pick file
  P->>P: parse JSON, strip _altTabExport
  P->>SW: sendMessage({action:'restore_session', mode:'replace', windowsData})
  SW->>SW: captureUndoSnapshot('session restore')
  SW->>C: close other normal windows
  SW->>C: tabs.remove curTabs[1..] (pivot kept)
  SW->>C: tabs.update pivot.url = firstUrls[0]
  loop firstUrls[1..]
    SW->>C: tabs.create(active:false)
  end
  loop groups[1..]
    SW->>C: windows.create({url: allUrls, focused:false})
  end
  SW->>C: muteTabs(allCreatedIds) + markPendingPause
  SW->>C: windows.update(lastWinId, focused:true)
  SW-->>P: {ok, tabCount, windowCount}

  Note over U,P: APPEND
  P->>SW: {action:'restore_session', mode:'append', windowsData}
  loop each group
    SW->>C: windows.create({url: urls, focused:false})
  end
  SW->>C: silenceTabs(all created)
  SW-->>P: {ok, tabCount, windowCount}
```

## 3. Hold / Fetch (preset snapshot)

```mermaid
sequenceDiagram
  participant U as User
  participant P as Popup
  participant SW as background.js
  participant C as chrome.*
  participant S as chrome.storage.local

  Note over U,P: HOLD N
  U->>P: click Hold N
  P->>C: windows.getAll({populate:true})
  P->>P: build windowsData, JSON.stringify, chunk if > 600 KB
  P->>S: set altTabPresetSlotN = payload

  Note over U,P: FETCH N (reuse restore path)
  U->>P: click Fetch N
  P->>S: get altTabPresetSlotN
  alt legacy sessionPresetSlotsV1 found
    P->>S: migrate into altTabPresetSlotN
    Note right of P: OLD KEY NOT DELETED (CQ-03 in plan2.md)
  end
  P->>SW: {action:'restore_session', mode:'replace', windowsData}
  Note right of SW: same path as Load above
```

## 4. Undo / Redo toggle

```mermaid
sequenceDiagram
  participant U as User
  participant P as Popup
  participant SW as background.js
  participant S as altTabUndoSnapshot

  Note over SW: Every UNDOABLE action captures a pre-op snapshot
  U->>P: click Close duplicates
  P->>SW: {action:'remove_duplicates'}
  SW->>S: captureUndoSnapshot('close duplicates')
  SW->>SW: tabs.remove(dupIds) + bump stats
  SW-->>P: {ok, count}
  P->>P: refreshUndoButton → "Undo close duplicates"

  Note over U,P: User undoes
  U->>P: click Undo
  P->>SW: {action:'undo'}
  SW->>S: captureUndoSnapshot('redo close duplicates')
  SW->>SW: restoreSession('replace', snap.windowsData)
  SW-->>P: {ok, tabCount, windowCount}
  P->>P: refreshUndoButton → "Undo redo close duplicates"

  Note over U,P: User clicks again — redo
  U->>P: click Undo (labelled "redo …")
  P->>SW: {action:'undo'}
  SW->>S: captureUndoSnapshot('redo redo close duplicates')
  SW->>SW: restoreSession to post-op state (duplicates gone again)
  SW-->>P: {ok, ...}
  P->>P: refreshUndoButton → toggles forever
```

## 5. Silence (mute + pause) subsystem

```mermaid
flowchart TB
  subgraph SW[background.js]
    SR[restoreSession]
    MT[moveTabsToNewWindow]
    SI[silenceTabs]
    MU[muteTabs<br/>chrome.tabs.update muted:true]
    PA[pauseMediaInTab<br/>scripting.executeScript]
    MP[markPendingPause<br/>altTabPendingPauseIds]
  end

  subgraph Listener[chrome.tabs.onUpdated complete]
    CP[consumePendingPause<br/>→ pauseMediaInTab again]
  end

  SR -->|replace mode| MU
  SR --> MP
  SR -->|append mode| SI
  SI --> MU
  SI --> PA
  SI --> MP

  MP -.stored.-> Storage[(chrome.storage.local)]
  Storage -.read on update.-> CP
  CP --> PA

  MT -.no silence.-> MT
```

`moveTabsToNewWindow` (extract, regroup, extract-by-string) intentionally does NOT
touch mute state. Silencing is scoped to Session Restore only.

## 6. Extract current domain / by string — OK (no mute)

```mermaid
flowchart TB
  Popup[popup: getActiveTabId] -->|sendMessage activeTabId| SW
  subgraph SW[SW: extractCurrentDomain / extractByString]
    R[resolveActiveTab]
    G[getAllTabsFlat]
    F[filter by domain / needle]
    M[moveTabsToNewWindow:<br/>windows.create tabId → tabs.move rest]
  end
  R --> G --> F --> M
```

Extract preserves mute/media state — YouTube keeps playing after it moves.

## 7. Permissions map

```mermaid
flowchart LR
  subgraph Permissions["manifest.json permissions"]
    P_t[tabs]
    P_c[commands]
    P_s[scripting]
    P_st[storage]
    P_tg[tabGroups]
    P_h["host: <all_urls>"]
  end

  P_t --> Fn_tabs["tab.url / title / query / move / remove / update / create"]
  P_c --> Fn_cmd["commands.onCommand sort shortcuts"]
  P_s --> Fn_scr["scripting.executeScript (pause media)"]
  P_tg --> Fn_group["groupByDomainTabGroups"]
  P_st --> Fn_store["themePref, dailyStats, presets, undoSnap, pendingPause"]
  P_h --> Fn_read_urls["cross-origin tab.url + scripting target"]

```

(`activeTab` permission was removed — `tabs` + `<all_urls>` cover everything.)

## 8. Storage keys

```mermaid
flowchart LR
  subgraph Legacy["Legacy (pre-split)"]
    L1[sessionPresetSlotsV1:<br/>Array of 4 slots]
  end

  subgraph Current["Current per-slot keys"]
    C1[altTabPresetSlot0..3]
  end

  subgraph New["Added by recent waves"]
    U[altTabUndoSnapshot<br/>{v:1, label, tabCount, windowCount, savedAt, j|jp}]
    P[altTabPendingPauseIds<br/>{[tabId]: timestamp}]
    D[altTabDailyCloseStats<br/>{day, dupTabs, domainTabs}]
    T[themePref]
  end

  L1 -.migrateLegacyPresetsOnce.-> C1
  L1 -.deleted after success.-> X[gone]
```

---

See `plan2.md` for findings and prioritised fixes, `AGENTS.md` for text-form codepaths.
