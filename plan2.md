# plan2.md — Bug Hunt Alt Tab (2026-04-17) — ALL WAVES SHIPPED

> Финальный отчёт: все 4 волны применены, 4 коммита на ветке
> `fix/session-restore-and-popup-lifecycle`. `bun run lint` зелёный.

## Результат

| Wave | Коммит | Тема |
|---|---|---|
| 1 | `3f2a473` | debug cleanup + consistency |
| 2 | `9ce0fde` | undo redo + silence + mute naming |
| 3 | `ee54296` | tooltip cache, legacy migration, skipped-count, v-check |
| 4 | `b134f19` | DRY + envelope v2 + pinned preservation + storage trim |

Изменение строк суммарно:
- `background.js`: 752 → 776 (+24 — pin preservation, undo-redo capture, skipped count)
- `popup_working.js`: 1525 → 1325 (-200 — DOM-localStorage fallback removed, 3× arm/reset collapsed, formatAge×2 → 1)
- `popup.css`: 683 → 611 (-72 — dead CSS, --scope token)
- `manifest.json`: -1 permission (activeTab)

Ни одной new/bump-version ломающей фичи — все изменения совместимы с существующими
preset snapshots, undo snapshots, legacy `sessionPresetSlotsV1`, и v1 session JSON files.

---

## Wave 1 — debug cleanup + consistency (commit 3f2a473)

| ID | Suspicion | Action |
|---|---|---|
| NEW-01 | 2 debug `console.log` в `popup_working.js:526,528` от отладочного коммита `fd3f061` | удалены |
| CQ-01 | `setInterval(updateStats, 12000)` — popup-lifetime секунды, noop | удалён |
| CQ-02 | popup keydown `Ctrl+Shift+1..4` — дублирует `chrome.commands`, срабатывает дважды при открытом popup | удалён; Ctrl+K для Jump сохранён |
| CQ-07 | `activeTab` permission не используется (host `<all_urls>` + `tabs` covers) | удалён из manifest |
| DEAD | 11 неиспользуемых CSS классов (`.header-top`, `.brand`, `.app-sub`, `.header-meta`, `.theme-label`, `.scope-badge`, `.btn-row`, `.hint`, `.danger.card`, `.danger .card-head`, `.danger .card-title`) + token `--scope` | удалены |
| NEW-02 | `lastFocusedWindow: true` vs `currentWindow: true` — 3 места в popup несогласованы | все унифицированы на `currentWindow: true` |

---

## Wave 2 — undo redo + silence + mute naming (commit 9ce0fde)

| ID | Action |
|---|---|
| NEW-05 | `silenceTabs` убран из `moveTabsToNewWindow`. Extract / regroup / extract-by-string больше не мутят. Silencing остался ТОЛЬКО для session restore (replace: `muteTabs` + `markPendingPause`; append: `silenceTabs` т.к. группа может включать live-media). |
| NEW-04 | `undoLastAction` теперь перед `restoreSession` вызывает `captureUndoSnapshot('redo <label>')` → кнопка Undo после клика превращается в re-undo (toggle). Popup больше не зовёт `clear_undo`. |
| CQ-04 | HTML `id="stop_media"` → `id="mute_all"`. `elements.stopMedia` → `elements.muteAllBtn`. Функция `muteAllTabs` уже была правильно названа. |

---

## Wave 3 — tooltip cache, legacy migration, skipped-count, v-check (commit ee54296)

| ID | Action |
|---|---|
| NEW-03 | `getNormalWindowsCached()` с 1-секундным TTL. `getAllTabsAllWindows` / `updateStats` / tooltips используют кеш. `callSw()` invalidate-ет кеш после каждого SW-ответа — мутации видны сразу. |
| CQ-03 | Миграция legacy preset slots перенесена в одноразовый `migrateLegacyPresetsOnce()` на старте popup. После миграции всех 4 слотов `sessionPresetSlotsV1` **удаляется** из storage. |
| BUG-HTTP | `restoreSession` считает `skipped = totalUrls - kept`. Popup показывает `Loaded N tab(s) in M window(s); skipped K non-http.` в status bar. |
| CQ-05 | `loadTabsFromFile` проверяет `json._altTabExport.formatVersion`. Если больше поддерживаемой — warning-status, но загрузка продолжается. |
| BUG-APPEND | `data-append` DOM-атрибут заменён на `let pendingAppend = false` в замыкании `setupEventListeners`. |
| NEW-06 | `buildSessionExport` возвращает `{ windowsData, tabCount, windowCount }`. Уехал полный массив объектов табов, который использовался только ради `.length`. |
| NEW-07 | `countDuplicates` / `removeDuplicates` перешли на `getAllTabsFlat()` — только normal windows (devtools / PWA / popup windows больше не попадают в scan). |

---

## Wave 4 — DRY + envelope v2 + pinned preservation + storage trim (commit b134f19)

| ID | Action |
|---|---|
| DRY-01 | `makeArmedButton(el, {label, confirm, onConfirm, preArm?, ms?})` фабрика. Три почти идентичные пары arm/reset (close domain / dup URLs / delete) схлопнуты до 3 декларативных вызовов. Preset 2s TTL, mouseleave cancel, preArm hook для вето (close-domain проверяет active-tab URL). |
| DRY-02 | `formatAge` + `formatPresetAge` → `formatRelativeTime(ts)`. Одна реализация. |
| CQ-08 | DOM-localStorage fallback (~115 LoC с getExtensionStorageLocal / getExtensionLastError / storageLocalSetViaDomStorage / storageLocalGetViaDomStorage) удалён. MV3 popup всегда имеет `chrome.storage.local`. `storageLocalSet/Get/Remove` теперь тонкие алиасы. |
| CQ-06 | Session file envelope v2: `{ _altTabExport: { formatVersion: 2, savedAt }, windows: { [wid]: [urls] } }`. Loader (`extractWindowsDataFromFileJson`) читает оба: v2 (`json.windows`) и v1 (siblings). Preset snapshots не трогаются — они не file format. |
| BUG-PIN | `mergeAllWindows` собирает `pinnedIds` из других окон ДО move, и после move делает `chrome.tabs.update(id, {pinned: true})` по каждому. |
| data-armed | CSS `.btn[data-armed='true']` теперь общий, а не только для `.session-delete-row` — все confirm кнопки жирнеют при арме. |

---

## Намеренно не сделано

### DRY-03 — объединение `isRestrictedUrl` / `getDomain` между popup и SW

Варианты:
(a) `shared.js` с `importScripts()` в SW и `<script>` тегом в popup.html — требует реорганизации SW как module или самостоятельного шейринга скопированного кода;
(b) Перенести URL-валидацию полностью в SW и запрашивать через msg.

Это 3 короткие функции (~20 строк), дублирование безопасное и не эволюционирует.
Оставил как есть — сложность варианта (a) перевешивает выгоду. Если URL-валидация
начнёт расти, стоит вернуться к варианту (b): popup не должен знать URL-политик.

### Сохранение tab groups при `mergeAllWindows`

Pinned преобразуется, группы — нет. `chrome.tabGroups.query({windowId})` +
recreate в target window — отдельная история (нужно сохранить title, color).
Плюс edge cases (группа пустая после move). Отложено.

---

## Тестовый план (ручная проверка)

1. Открыть popup → сession panel → Save → файл v2 сохраняется → Load того же файла → окна восстановлены, skipped=0 в status.
2. Save v2 → вручную понизить `formatVersion` на 99 в файле → Load → warning-toast + loading продолжается.
3. Open legacy preset store (вручную через DevTools установить `sessionPresetSlotsV1`) → закрыть popup → reopen → legacy key исчез; новые `altTabPresetSlot0..3` появились.
4. Pin 2-3 таба в окне A → Merge all → в окне B эти табы снова pinned.
5. Extract this domain → табы в новом окне, плеер (YouTube) **продолжает играть** (не muted).
6. Load session с 50 YouTube ссылок → все табы загружаются muted и paused (тихо).
7. Close duplicate URLs → Undo в header → дубликаты вернулись → Undo снова → дубликаты снова закрыты (redo toggle).
8. Ctrl+Shift+1 при открытом popup — сортировка срабатывает ОДИН раз (не двойно).
9. Hover over 6 разных tooltip-кнопок в течение секунды → в DevTools SW-network видно 1 `windows.getAll`, не 6.
10. `bun run lint` — 0 errors, 0 warnings.

---

## Итог

- 4 коммита в ветке `fix/session-restore-and-popup-lifecycle` после маркера `0f9a119`.
- Popup похудел на 200 строк; дублирование arm/reset и DOM-localStorage-fallback изведено.
- Undo стал toggle'ом; silence больше не воюет с extract; manifest потерял неиспользуемый permission.
- Envelope v2 даёт место для мета-расширения без field-collision'ов.
- Pinned tabs выживают merge.

Готово. Проверить вручную по пунктам тест-плана и, если зелёно — `git push`.
