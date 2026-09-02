import type { Config } from "@opencode-ai/sdk/v2";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";

/**
 * Typed against the published API so host API drift fails during typecheck.
 * Renderer-adjacent fields are deliberately narrow casts because the model
 * never touches them.
 */

export interface FakeTuiApi {
  api: TuiPluginApi;
  setConfig(config: Partial<Config>): void;
  readonly toasts: { variant: string; title?: string; message: string }[];
  readonly disposeCallbacks: (() => void | Promise<void>)[];
  readonly kv: Map<string, unknown>;
}

function fail(what: string): never {
  throw new Error(`fake-tui-api: ${what} is not implemented`);
}

export function createFakeTuiApi(initialConfig: Partial<Config> = {}): FakeTuiApi {
  const toasts: { variant: string; title?: string; message: string }[] = [];
  const disposeCallbacks: (() => void | Promise<void>)[] = [];
  const kv = new Map<string, unknown>();
  let config: Partial<Config> = initialConfig;

  const api: TuiPluginApi = {
    app: { version: "0.0.0-test" },
    attention: {
      notify: () => fail("attention.notify"),
      soundboard: {
        registerPack: () => fail("soundboard.registerPack"),
        activate: () => fail("soundboard.activate"),
        current: () => fail("soundboard.current"),
        list: () => [],
      },
    },
    keys: {
      formatSequence: () => "",
      formatBindings: () => undefined,
    },
    mode: {
      current: () => fail("mode.current"),
      push: () => fail("mode.push"),
    },
    route: {
      register: () => fail("route.register"),
      navigate: () => fail("route.navigate"),
      get current() {
        return fail("route.current");
      },
    },
    ui: {
      Dialog: () => fail("ui.Dialog"),
      DialogAlert: () => fail("ui.DialogAlert"),
      DialogConfirm: () => fail("ui.DialogConfirm"),
      DialogPrompt: () => fail("ui.DialogPrompt"),
      DialogSelect: () => fail("ui.DialogSelect"),
      Slot: () => null,
      Prompt: () => fail("ui.Prompt"),
      toast: (input) => {
        toasts.push({
          variant: input.variant ?? "info",
          title: input.title,
          message: input.message,
        });
      },
      get dialog() {
        return fail("ui.dialog");
      },
    },
    kv: {
      get: <Value>(key: string, fallback?: Value) => {
        const value = kv.get(key);
        return value === undefined ? (fallback as Value) : (value as Value);
      },
      set: (key, value) => {
        kv.set(key, value);
      },
      get ready() {
        return true;
      },
    },
    state: {
      get ready() {
        return true;
      },
      get config() {
        return config as Config;
      },
      provider: [],
      path: { state: "", config: "", worktree: "", directory: "" },
      vcs: undefined,
      session: {
        count: () => 0,
        get: () => undefined,
        diff: () => [],
        todo: () => [],
        messages: () => fail("state.session.messages"),
        status: () => undefined,
        permission: () => [],
        question: () => [],
      },
      part: () => fail("state.part"),
      lsp: () => [],
      mcp: () => [],
    },
    theme: {
      current: {} as TuiPluginApi["theme"]["current"],
      selected: "test",
      has: () => false,
      set: () => false,
      install: () => fail("theme.install"),
      mode: () => "dark",
      get ready() {
        return true;
      },
    },
    event: {
      on: () => fail("event.on"),
    },
    lifecycle: {
      signal: new AbortController().signal,
      onDispose: (fn) => {
        disposeCallbacks.push(fn);
        return () => {
          const index = disposeCallbacks.indexOf(fn);
          if (index !== -1) disposeCallbacks.splice(index, 1);
        };
      },
    },
    keymap: {} as TuiPluginApi["keymap"],
    renderer: {} as TuiPluginApi["renderer"],
    client: {} as TuiPluginApi["client"],
    tuiConfig: {} as TuiPluginApi["tuiConfig"],
    slots: {
      register: () => fail("slots.register"),
    },
    plugins: {
      list: () => [],
      activate: () => fail("plugins.activate"),
      deactivate: () => fail("plugins.deactivate"),
      add: () => fail("plugins.add"),
      install: () => fail("plugins.install"),
    },
  };

  return {
    api,
    setConfig: (next) => {
      config = next;
    },
    toasts,
    disposeCallbacks,
    kv,
  };
}
