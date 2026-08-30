# supercode.update-checker

TUI-плагин OpenCode: раз в 24 часа сверяет установленные npm-плагины из effective
config и Managed Tools с `latest` в npm registry и показывает, где есть обновления.
Ничего не ставит и не удаляет сам — только помечает кэш к инвалидации (ADR
`docs/adr/041-update-checker/0016`).

## Статус

Реализованы тикеты 01–05 (`.scratch/041-update-checker/issues/`): checker без TUI,
Managed Tools, 24h-цикл + toast, Pending Invalidation + recovery, и каркас TUI-плагина —
route `/plugin-updates`, команда в command palette, read-only экран с тремя группами.
Интерактив (выбор, confirm, `R`) — тикет 06.

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
- `src/update-checker.tsx` — каркас TUI-плагина (View + регистрация, логики нет):
  `route.register("plugin-updates")`, команда `Plugin updates` с `slashName:
  "plugin-updates"` в command palette через `keymap.registerLayer`, стартовый цикл
  `model.start()` асинхронно при загрузке. Экран read-only: три группы
  (Plugins / Managed tools / Skipped) с сохранённым снапшотом из kv сразу при
  открытии, индикатор идущей проверки поверх, Esc возвращает на предыдущий route.
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
4. `Esc` возвращает на предыдущий экран.
