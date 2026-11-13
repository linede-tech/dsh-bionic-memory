/**
 * Client-half structural smoke test.
 *
 * Loads client.js with a stubbed module loader and a stubbed React, then runs
 * its `apply(ctx)` against a fake Client context. This validates the locale
 * dictionaries and the shell.overlay registration wiring without a browser.
 */

import assert from 'node:assert/strict';

let captured = null;
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      captured = entry;
    },
  },
};

await import('../client.js');

assert.ok(captured, 'client module called __ModuleLoader__.load');
assert.equal(captured.id, '@local/dsh-bionic-memory', 'module id matches the package name');

const fakeReact = {
  createElement(type, props, ...children) {
    return { type, props, children };
  },
  useState(initial) {
    return [initial, () => {}];
  },
  useEffect() {},
  useCallback(fn) {
    return fn;
  },
};

const plugin = captured.factory((id) => {
  if (id === 'react') return fakeReact;
  throw new Error(`unexpected require: ${id}`);
});

assert.ok(plugin && typeof plugin.apply === 'function', 'factory returns a plugin apply()');
assert.deepEqual(plugin.inject, ['slots', 'locale'], 'client plugin injects slots and locale');

const registered = [];
const effects = [];
const ctx = {
  effect(fn, label) {
    effects.push(label);
    const disposer = fn();
    return typeof disposer === 'function' ? disposer : () => {};
  },
  locale: {
    register(namespace, locale, dict) {
      assert.equal(namespace, 'bionic-memory');
      assert.ok(locale === 'en' || locale === 'zh');
      assert.equal(typeof dict, 'object');
      assert.equal(typeof dict.title, 'string');
      return () => {};
    },
    bind() {
      return (key) => key;
    },
    subscribe() {
      return () => {};
    },
  },
  slots: {
    inject(slotName, callback) {
      assert.equal(slotName, 'shell.overlay');
      return callback();
    },
    register(options, component) {
      registered.push({ options, component });
      return () => {};
    },
  },
};

plugin.apply(ctx);

assert.equal(registered.length, 1, 'exactly one slot registration');
assert.equal(registered[0].options.name, 'shell.overlay');
assert.equal(registered[0].options.id, 'bionic-memory');
assert.equal(typeof registered[0].component, 'function');

console.log('ok - client module id and factory');
console.log('ok - locale dictionaries register for en and zh');
console.log('ok - shell.overlay registration wired with the bionic-memory id');
console.log('PASS: client smoke');
