/**
 * Build both halves of the plugin.
 *
 * A plain script rather than a `tsdown.config.*` file: this checkout's tsdown
 * loads a config file through `unrun`, which is not in its dependency set, so
 * the CLI path cannot start. The programmatic `build()` API takes the same
 * options inline and never touches the config loader.
 *
 * `config: false` is required — without it every call still probes for a
 * config file and re-enters the failing import.
 */
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build } from 'tsdown'

/** Plugin id stamped into the module-loader handoff. */
const ID = 'dsh-plugin-dependency-graph'

/**
 * This script's own directory. Every path below is resolved against it rather
 * than the caller's cwd, so the build works whether it is run from inside the
 * plugin (`npm run build`) or from the repository root (`tsx session-messages-plugin/build.mjs`)
 * — relying on cwd silently looked for `<repo>/src/index.ts` in the latter case.
 */
const ROOT = fileURLToPath(new URL('.', import.meta.url))

/** Something with no importer is an entry, which must stay internal. */
function isEntryImport(importer) {
  return importer === undefined
}

/** Whether a specifier is bare (a package name) rather than a path. */
function isBare(source) {
  return !source.startsWith('.') && !source.startsWith('\0') && !source.startsWith('/')
}

/**
 * Node half: bare specifiers stay external and Node resolves them, which is how
 * every other Loader entry works — and it is what keeps a shared library SINGLE:
 * bundling `schemastery` here would give the host's Schema a second copy, and
 * schema identity is compared by reference.
 */
const nodeExternals = {
  name: 'dsh-node-externals',
  resolveId: {
    order: 'pre',
    handler(source, importer) {
      if (isEntryImport(importer)) return null
      return isBare(source) ? { id: source, external: true } : null
    },
  },
}

/**
 * Browser half: a WHITELIST, not "everything bare".
 *
 * The browser module table answers exactly three things — platform seeds,
 * already-materialized modules, and registered package factories (the
 * composition's own client bundles). Anything outside that set is unreachable at
 * runtime however it is declared: `require` throws "missed the module table", and
 * the page shows a failed plugin instead of the surface. ui-chat can import
 * `@deepseek-ai/dsh-token-meter/client` because it is BUNDLED INTO THE SAME
 * BUNDLE, not because the table serves it.
 *
 * So the polarity matters: a specifier named here stays external (it must be
 * answered by the table), and EVERYTHING ELSE IS BUNDLED, which always works.
 * Externalizing by default was the bug — it turns any package the table does not
 * happen to carry into a boot failure, which is precisely the "build-time
 * externals drift" the loader's error names.
 */
const TABLE_PACKAGES = [
  // Platform seeds. Listed as packages, not exact specifiers: the JSX transform
  // rewrites JSX into `react/jsx-runtime`, and bundling THAT drags React's
  // development branch — and its `process.env.NODE_ENV` — into the browser.
  'react',
  'react-dom',
]

/** Whether a specifier is served by the module table. */
function tableAnswers(source) {
  return TABLE_PACKAGES.some(name => source === name || source.startsWith(`${name}/`))
}

const browserExternals = {
  name: 'dsh-browser-table-externals',
  resolveId: {
    order: 'pre',
    handler(source, importer) {
      if (isEntryImport(importer)) return null
      return tableAnswers(source) ? { id: source, external: true } : null
    },
  },
}

/**
 * Refuse to ship a browser bundle that cannot run in a browser.
 *
 * The host's own client build passes a purity gate; a third-party plugin builds
 * outside it, so the same mistakes surface as a page-level failure instead — the
 * two that have already happened here were `require` of a package the module
 * table does not carry ("missed the module table") and a bundled React
 * development branch ("process is not defined"). Both are visible in the finished
 * artifact, so both are checked there, before the plugin is installed rather than
 * after it fails to load.
 * @param artifact - absolute path of the browser bundle.
 */
function assertBrowserPurity(artifact) {
  const text = readFileSync(artifact, 'utf8')
  const leaked = ['process.', 'Buffer', '__dirname', 'globalThis.process']
    .filter(token => text.includes(token))
  if (leaked.length > 0) {
    throw new Error(
      `client bundle references Node globals (${leaked.join(', ')}) — a bundled dependency is not `
      + 'browser-safe; keep it external if the module table carries it, or inline only the pure part',
    )
  }
  const requires = [...text.matchAll(/require\("([^"]+)"\)/gu)].map(match => match[1])
  const unknown = [...new Set(requires)].filter(spec => !tableAnswers(spec))
  if (unknown.length > 0) {
    throw new Error(
      `client bundle requires specifiers the module table does not answer (${unknown.join(', ')}) — `
      + 'bundle them instead (see TABLE_PACKAGES for what stays external)',
    )
  }
}

/** Shared options for both halves. */
const common = {
  config: false,
  format: ['esm'],
  target: 'es2024',
  dts: false,
  clean: false,
  outDir: `${ROOT}lib`,
}

// Node half: the Loader imports this by `main` for name, Config, and apply.
await build({
  ...common,
  entry: { index: `${ROOT}src/index.ts` },
  platform: 'node',
  plugins: [nodeExternals],
  // Rolldown defaults the ESM output to .mjs; both halves are named from the
  // package.json exports map, so pin the extension instead of restating it.
  outputOptions: { entryFileNames: 'index.js' },
})

// Browser half: a closure factory registered with the client module loader.
// `cjs`, not `esm`: the factory receives `require` and runs as a function
// body, so ESM `import` statements would be illegal there. The repository's
// own client preset makes the same choice (packages/client/tsdown.client.ts).
await build({
  ...common,
  format: ['cjs'],
  entry: { client: `${ROOT}src/client/index.ts` },
  platform: 'browser',
  plugins: [browserExternals],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})

// Standalone viewer: a whole page rather than a module-loader factory. React is
// BUNDLED here instead of left external — this script runs on a page with no
// module table, so anything left external would fail at load with "missed the
// module table". `define` settles the `process.env.NODE_ENV` branch React's CJS
// entry uses to choose its production build, which is also what keeps `process.`
// out of the artifact — a requirement here, not a preference.
await build({
  ...common,
  format: ['iife'],
  entry: { viewer: `${ROOT}src/viewer/main.tsx` },
  platform: 'browser',
  // tsdown externalises `peerDependencies` by default, and react/react-dom are
  // declared there for the client half's sake. Here they have to be inlined:
  // nothing on a standalone page can answer a bare `react` import.
  //
  // Every subpath is listed explicitly — matching is by SPECIFIER, so naming the
  // package covers neither `react-dom/client` nor `react/jsx-runtime`, and the
  // latter is not optional: it is what the JSX transform emits, so missing it
  // leaves the page with an undefined global and no bundle-time complaint beyond
  // a warning.
  deps: {
    alwaysBundle: [
      'react',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
      'react-dom',
      'react-dom/client',
    ],
  },
  define: { 'process.env.NODE_ENV': '"production"' },
  outputOptions: { entryFileNames: 'viewer.js' },
})

// The browser halves are checked before they can be installed: both failure
// modes this guards were silent until a page tried to load them.
assertBrowserPurity(`${ROOT}lib/client.js`)
assertBrowserPurity(`${ROOT}lib/viewer.js`)

// The design tokens for the standalone viewer, copied from the theme package so
// both surfaces share ONE source of truth — light and dark included, switched by
// `body[data-ds-dark-theme]` exactly as the app switches them. Copied at build
// time rather than resolved at serve time: the theme package is not a dependency
// of this plugin, so a runtime resolution would depend on where the host happened
// to install things. The cost is that the copy is only as fresh as the last build.
// Two sources, tried in order, because this plugin is built in two places:
//
// - inside the host checkout, where `../packages/...` exists and is LIVE — used
//   first so the copy tracks the host's theme rather than a snapshot;
// - anywhere else — a standalone clone, or an install from npm — where
//   `assets/design-platform.css` is the only one there. That file is a COMMITTED
//   SNAPSHOT of the same stylesheet, so the standalone build still produces a
//   themed viewer instead of failing.
//
// Neither present is not an error: `viewer-page.ts` carries a fallback of its
// own and the viewer simply looks plainer. Failing the build over a stylesheet
// would make the plugin unbuildable for someone who only wants the graph.
const THEME_SOURCES = [
  new URL('../packages/client/ui-theme/src/styles/design-platform.css', import.meta.url),
  new URL('./assets/design-platform.css', import.meta.url),
]
const theme = THEME_SOURCES.find(source => existsSync(source))
if (theme === undefined) {
  console.warn('dependency-graph: no design tokens found — the viewer keeps its fallback styles')
} else {
  copyFileSync(theme, new URL('./lib/theme.css', import.meta.url))
  if (!theme.pathname.includes('/packages/')) {
    console.warn('dependency-graph: theme.css came from the committed snapshot; refresh assets/ when the host theme changes')
  }
}

console.log('dsh-plugin-dependency-graph: built lib/index.js, lib/client.js and lib/viewer.js')
