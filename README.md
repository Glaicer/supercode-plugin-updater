# supercode.update-checker

TUI-плагин OpenCode: раз в 24 часа сверяет установленные npm-плагины из effective
config и Managed Tools с `latest` в npm registry и показывает, где есть обновления.
Ничего не ставит и не удаляет сам — только помечает кэш к инвалидации (ADR
`docs/adr/041-update-checker/0016`).

## Статус

Реализованы тикеты 01–06 (`.scratch/041-update-checker/issues/`): checker без TUI,
Managed Tools, 24h-цикл + toast, Pending Invalidation + recovery, каркас TUI-плагина и
интерактив — выбор по Space/`A`, confirm-dialog перед подготовкой, `R` — ручной цикл без
TTL. Остаётся ручной smoke полного цикла в живом TUI (гейт закрытия фичи, см. «Проверка»).

## Модули

- `src/checker.ts` — контракт registry-порта (`fetchLatest`), дефолтный npm-порт,
  semver-lite сравнение по тройке major/minor/patch.
- `src/plugins.ts` — таксономия спеков effective config: Floating (`foo`,
  `foo@latest`), Pinned (`foo@1.2.3`, registry не спрашивается), Unsupported
  (локальные пути, `file:`, `git+`, URL, semver-диапазоны, другие dist-теги).
- `src/cache.ts` — адаптер `PackageCache` над `~/.cache/opencode/packages`:
  установленная версия из `<key>/node_modules/<name>/package.json`, bare name
  нормализуется в `name@latest`, scoped-плагин читается из диры текущего
  резолвера (`@scope/name@latest`), tools — голая дира `<name>`.
- `src/update-model.ts` — Update Model: единственный автоматизируемый шов. Один
  цикл проверки: per-request таймаут 5s, пул на 4 параллельных запроса, отказ
  одного пакета даёт ему статус `unknown` и не срывает цикл; registry опрашивается
  только за пакетами, чья дира есть в кэше. Подтверждение пишет Pending
  Invalidation в kv; dispose и recovery дозакрывают его поэлементно.
- `src/selection.ts` — правила выбора экрана (тестовый шов тикета 06): выбираемы
  ровно `status: "checked"` кандидаты обоих видов; pinned, unknown и skipped не
  попадают в выбор ни по Space, ни по `A`.
- `src/update-checker.tsx` — TUI-плагин (View + регистрация, логики нет):
  `route.register("plugin-updates")`, команда `Plugin updates` с `slashName:
  "plugin-updates"` в command palette через `keymap.registerLayer`, стартовый цикл
  `model.start()` асинхронно при загрузке. Экран: три группы (Plugins / Managed
  tools / Skipped), сохранённый снапшот из kv сразу при открытии, индикатор идущей
  проверки, клавиши Space / `A` / `U` / `R` / Esc (плюс `j`/`k` для курсора).
  `U` открывает `ui.DialogConfirm` со списком выбранных; подтверждение вызывает
  `model.confirm` (Pending Invalidation в kv + один toast «Updates prepared…»),
  экран показывает pending-баннер; до dispose файловая система не трогается.
  `R` — ручной цикл модели, TTL игнорирует, тоста нет; при полном отказе registry
  список остаётся с предыдущим результатом. Клавиши экрана не активны, пока открыт
  confirm-dialog.
- `src/fake-tui-api.ts` — фейковый `TuiPluginApi` для тестов (in-memory kv,
  effective config, захват toast/dispose; registry — инъекция).

## Установка

TUI-плагины директорию `~/.config/opencode/plugins/` сканером не читаются —
нужны оба шага (проверено в 039: голый симлинк ничего не грузит):

1. Симлинк в директорию плагинов:

   ```bash
   ln -sfn <repo>/plugins/plugin-updater/src/update-checker.tsx \
     ~/.config/opencode/plugins/update-checker.tsx
   ```

2. Путь в `plugin` массив `~/.config/opencode/tui.json`:

   ```jsonc
   {
     "plugin": ["/home/<user>/.config/opencode/plugins/update-checker.tsx"]
   }
   ```

Сборки нет: `.tsx` транспилируется хостом на лету, правки подхватываются
перезапуском TUI (US 34, 35).

## Проверка

```bash
npm run typecheck   # tsc --noEmit
npm test            # node --test, без сети: registry и кэш (tmpdir) — фикстуры
```

Ручной smoke в живом TUI (не автоматизируется, Testing Decisions):

1. Перезапустить TUI → диалог Plugins (`ctrl+p` → `plugins`) показывает
   `supercode.update-checker` со статусом `active`; лог без ошибок загрузки.
2. При наличии обновлений — один toast «N OpenCode updates available…».
3. `ctrl+p` → `updates` → Enter: экран `/plugin-updates` рендерит сохранённый
   список сразу (три группы, skipped-спеки с причиной), поверх — индикатор,
   пока цикл идёт.
4. Space переключает чекбокс под курсором (`j`/`k`/стрелки — курсор), `A`
   выделяет все выбираемые; pinned (бейдж `pinned at X.Y.Z`), unknown
   (строка статуса) и skipped чекбокс не получают.
5. `U` без выбранных — no-op; с выбранными — confirm-dialog со списком.
   Отмена (esc/cancel) ничего не пишет; подтверждение — toast «Updates
   prepared. Restart OpenCode to apply them.», на экране pending-баннер.
6. `R` — список обновляется без 24ч-ограничения, тоста нет.

Полный цикл «рестарт применяет обновление» (гейт закрытия фичи 041, не гейт
тестов) — на фикстурном пакете, чтобы не трогать реальные плагины:

1. Положить в кэш фикстурный пакет старой версии:
   `~/.cache/opencode/packages/<fixture>@latest/node_modules/<fixture>/package.json`
   с `"version": "0.0.1"`, а в `plugin` массив конфига — спеку `<fixture>`.
2. Запустить TUI с чистым `plugin-updates.*` в kv → toast про обновления,
   на экране строка `<fixture>  0.0.1 → <current latest>`.
3. Выбрать, `U`, подтвердить → toast + pending-баннер; выйти из OpenCode
   (штатный выход) — дира `~/.cache/opencode/packages/<fixture>@latest`
   исчезает, остальной кэш не тронут.
4. Запустить OpenCode снова — штатный резолвер ставит свежую версию пакета.
5. Открыть экран и нажать `R` (ручной цикл, TTL игнорирует) — предложений по
   фикстуре нет: версии равны, повторного предложения не будет (US 27).
