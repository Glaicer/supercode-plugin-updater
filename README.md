# supercode.update-checker (в разработке)

TUI-плагин OpenCode: раз в 24 часа сверяет установленные npm-плагины из effective
config с `latest` в npm registry и показывает, где есть обновления. Ничего не
ставит и не удаляет сам — только помечает кэш к инвалидации (ADR
`docs/adr/041-update-checker/0016`).

## Статус

Реализован тикет 01 (`.scratch/041-update-checker/issues/01-check-cycle-plugins.md`):
первый вертикальный срез checker'а **без TUI** — таксономия спеков → `PackageCache`
→ registry (инъекция) → Update Model, выдающая список Update Candidates. Ни route,
ни toast, ни keymap пока нет; установка появится в тикете 05.

## Модули

- `src/checker.ts` — контракт registry-порта (`fetchLatest`), дефолтный npm-порт,
  semver-lite сравнение по тройке major/minor/patch.
- `src/plugins.ts` — таксономия спеков effective config: Floating (`foo`,
  `foo@latest`), Pinned (`foo@1.2.3`, registry не спрашивается), Unsupported
  (локальные пути, `file:`, `git+`, URL, semver-диапазоны, другие dist-теги).
- `src/cache.ts` — адаптер `PackageCache` над `~/.cache/opencode/packages`:
  установленная версия из `<key>/node_modules/<name>/package.json`, bare name
  нормализуется в `name@latest`, scoped-плагин читается из диры текущего
  резолвера (`@scope/name@latest`).
- `src/update-model.ts` — Update Model: единственный шов. Один цикл проверки:
  per-request таймаут 5s, пул на 4 параллельных запроса, отказ одного пакета
  даёт ему статус `unknown` и не срывает цикл; registry опрашивается только за
  пакетами, чья дира есть в кэше.
- `src/fake-tui-api.ts` — фейковый `TuiPluginApi` для тестов (in-memory kv,
  effective config, захват toast/dispose; registry — инъекция).

## Проверка

```bash
npm run typecheck   # tsc --noEmit
npm test            # node --test, без сети: registry и кэш (tmpdir) — фикстуры
```
