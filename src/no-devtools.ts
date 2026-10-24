// react-lang auto-mounts the OpenUI devtools widget in development; the demo never wants it.
// Must be imported before react-lang.
;(globalThis as Record<symbol, unknown>)[Symbol.for('openui.devtools.autoMount')] = true
export {}
