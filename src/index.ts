/**
 * Host half of the plugin-graph plugin.
 *
 * It answers one question about the running composition: which plugin provides
 * the services every other plugin injects. The answer is assembled from three
 * places, each supplying one piece:
 *
 * - the Loader's own entry list — which carries the plugin NAME, and therefore
 *   the node labels a reader recognises;
 * - Cordis's reflection layer — `reflect.store` names the fiber that provides
 *   each service, which is one end of every dependency;
 * - Cordis's plugin registry — `runtime.fibers` enumerates every live fiber,
 *   which is what makes the other end complete: a plugin's dependencies are the
 *   union over every fiber it started, not just the one its module began.
 *
 * No one of them is enough alone. `reflect.store` has no plugin names (only
 * fibers); the entry list has no edges (only declarations); and `entry.fiber`
 * alone hides every service a plugin acquires at runtime through
 * `ctx.inject(deps, callback)`, because that helper starts a fiber of its own.
 *
 * The graph is served over HTTP rather than injected into the index page, because
 * it is not static: `dsh-tool-cordis` can mount and unmount dynamic packages, so a
 * snapshot taken at boot would go stale while the page is open.
 *
 * Scope: the HOST runtime only. The browser half is a different Cordis tree with
 * its own `reflect` and its own service names; merging the two would not be a
 * bigger graph, it would be a wrong one.
 * @module dsh-plugin-graph
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only merges: these pull in ctx.loader and ctx.webServer.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-host-webserver'

export const name = 'plugin-graph'



import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectGraph } from './collect.ts'
import { applyDescriptions } from './describe.ts'
import {
  CLIENT_GRAPH_PATH, DESCRIPTIONS_PATH, GRAPH_PATH, THEME_CSS_PATH, VIEWER_PATH, VIEWER_SCRIPT_PATH,
} from './graph-types.ts'
// Only the report itself: `PluginGraph` is re-exported below, and importing the
// name here as well is a duplicate identifier.
import type { ClientGraphReport } from './graph-types.ts'
import type {
  GraphEdge, GraphInjection, GraphNode, IsolatedService, PluginGraph, UnresolvedDependency,
} from './graph-types.ts'
import { viewerPage } from './viewer-page.ts'

// Re-exported so the module's public face is unchanged by the extraction: the
// collector moved to its own file, but `import { collectGraph } from 'dsh-plugin-graph'`
// still answers here.
export { collectGraph }
export { GRAPH_PATH, VIEWER_PATH }
export type {
  GraphEdge, GraphInjection, GraphNode, IsolatedService, PluginGraph, UnresolvedDependency,
} from './graph-types.ts'

/**
 * Absolute path of the built viewer script.
 *
 * Resolved against this MODULE rather than the process's working directory: the
 * Node half runs as `lib/index.js` from whatever directory the profile happened
 * to be started in, and `viewer.js` is its sibling in that same `lib/`.
 */
const VIEWER_SCRIPT = fileURLToPath(new URL('./viewer.js', import.meta.url))
/** The design tokens copied at build time, served beside the viewer. */
const THEME_CSS = fileURLToPath(new URL('./theme.css', import.meta.url))

/**
 * Requirers to try, in order, when resolving a package name.
 *
 * More than one, because where a package CAN be found depends on which chain the
 * resolution starts from, and the obvious base is the wrong one:
 *
 * This plugin is normally reached through a SYMLINK into a profile's
 * `node_modules` (measured: `~/.dsh/profiles/web/node_modules/dsh-plugin-graph →
 * the checkout`). Node resolves modules from the symlink's TARGET — the checkout
 * — so `createRequire(import.meta.url)` sees the checkout's own dependencies
 * (`@deepseek-ai/*`, which are in its `node_modules`) and NOT the third-party
 * plugins, which are installed in the profile. Measured too: `dshmarket` failed
 * to resolve from here by `MODULE_NOT_FOUND` while the same call from the profile
 * directory answered immediately.
 *
 * So the host's own entry point comes first: whatever `process.argv[1]` is, it
 * lives on the same resolution chain as everything the host loaded, including
 * the plugins it is describing. The working directory is the last resort, for a
 * host started from inside the profile rather than by path.
 */
function staticBases(): string[] {
  const bases: string[] = [import.meta.url]
  if (process.argv[1] !== undefined) bases.push(process.argv[1])
  bases.push(join(process.cwd(), 'plugin-graph-resolve.js'))
  return bases
}

/**
 * Bases learned from the host at runtime, tried BEFORE the static ones.
 *
 * This is the one that actually finds third-party plugins. The static bases all
 * land on the checkout: the plugin is reached through a symlink (so
 * `import.meta.url` is the checkout) and the host is started as
 * `node --import tsx/esm apps/cli/src/bin.ts web` (so `argv[1]` and the working
 * directory are the checkout too). Measured against a running host: of 69
 * descriptions served, exactly one was for a package outside `@deepseek-ai/` —
 * every third-party plugin was missing, which is the whole point of the feature.
 *
 * The profile directory comes from the host's own `profileContext.dir`, which is
 * where the packages are installed; `createRequire` from a file inside it walks
 * up to that profile's `node_modules`.
 */
const LEARNED_BASES: string[] = []

/**
 * Tell the reader where the profile's packages live.
 *
 * Clears the cache: everything resolved before this call was asked without the
 * base that matters, so its `null` answers are about the search, not about the
 * packages.
 * @param dir - the profile directory, from `profileContext`.
 */
export function useProfileDirectory(dir: string): void {
  const base = join(dir, 'plugin-graph-resolve.js')
  if (!LEARNED_BASES.includes(base)) LEARNED_BASES.unshift(base)
  DESCRIPTIONS.clear()
}

/**
 * Descriptions already read, by package name. `null` means "looked, and it does
 * not say" — cached too, so a package without one is not re-resolved on every
 * request. A description changes only when the package is reinstalled, which for
 * a running host means never.
 */
const DESCRIPTIONS = new Map<string, string | null>()

/**
 * Read one package's own description.
 *
 * From the package's ENTRY, then up to the nearest `package.json`: asking for
 * `${name}/package.json` directly would obey the package's `exports`, and a
 * package that does not list `./package.json` there would go unanswered even
 * though its manifest sits right beside its entry. The walk stops at the first
 * manifest whose `name` matches — otherwise it would climb out of the package and
 * describe it with its workspace root's words.
 *
 * Every failure is the same answer: an unresolvable name (a virtual entry, a
 * built-in, a path rather than a package) and a package that simply has no
 * description both leave the node without one. Nothing here is worth failing a
 * request over, and "this package does not describe itself" is a fact the panel
 * can draw honestly by drawing nothing.
 * @param name - the package name a node carries.
 * @returns the description, or null.
 */
export function descriptionOf(name: string): string | null {
  const cached = DESCRIPTIONS.get(name)
  if (cached !== undefined) return cached
  let found: string | null = null
  let entry: string | null = null
  // Learned bases first: when the host has told us where its profile is, that is
  // the chain the third-party packages are on, and it settles the answer without
  // walking the checkout's own tree at all.
  for (const base of [...LEARNED_BASES, ...staticBases()]) {
    try {
      entry = createRequire(base).resolve(name)
      break
    } catch {
      // Not on this chain — the next base may be the one the host used.
    }
  }
  try {
    if (entry === null) throw new Error('unresolvable')
    let dir = dirname(entry)
    for (let hops = 0; hops < 4; hops += 1) {
      try {
        const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
          name?: unknown
          description?: unknown
        }
        if (manifest.name === name) {
          found = typeof manifest.description === 'string' && manifest.description.trim() !== ''
            ? manifest.description
            : null
          break
        }
      } catch {
        // No readable manifest at this level — keep walking up.
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch {
    found = null
  }
  DESCRIPTIONS.set(name, found)
  return found
}

/** The description for every package a graph names, ready for {@link applyDescriptions}. */
function lookupFor(graph: PluginGraph): Record<string, string> {
  const lookup: Record<string, string> = {}
  for (const node of graph.nodes) {
    const description = descriptionOf(node.name)
    if (description !== null) lookup[node.name] = description
  }
  return lookup
}


/**
 * Serve the graph, its standalone viewer page, and the viewer's script.
 *
 * Three routes rather than one with a switch: they are three different content
 * types with three different lifetimes — the graph is computed per request, the
 * page is a constant, and the script is read per request so that rebuilding the
 * viewer takes effect on a reload instead of requiring the host to restart.
 * @param ctx - host context.
 */
/**
 * The browser half's last report, or null before any app has sent one.
 *
 * Held in memory rather than written down: it describes a runtime that only
 * exists while a page is open, so a report surviving a host restart would be
 * describing something that is not there.
 */
let clientReport: ClientGraphReport | null = null

/**
 * Accept a report only if it has the shape the viewer will render.
 *
 * This arrives over HTTP from a same-origin page rather than from our own code,
 * so it is input: a malformed one would not fail here, it would fail in the
 * viewer's canvas with a stack the reader cannot act on. Checking the top-level
 * arrays is enough to keep that from happening, and cheap enough to do on every
 * request.
 * @param value - the parsed request body.
 * @returns the report, or null when it is not one.
 */
function asReport(value: unknown): ClientGraphReport | null {
  if (typeof value !== 'object' || value === null) return null
  const { graph, at } = value as { graph?: unknown; at?: unknown }
  if (typeof at !== 'number' || !Number.isFinite(at)) return null
  if (typeof graph !== 'object' || graph === null) return null
  const candidate = graph as Partial<Record<'nodes' | 'edges' | 'unresolved' | 'isolated', unknown>>
  for (const field of ['nodes', 'edges', 'unresolved', 'isolated'] as const) {
    if (!Array.isArray(candidate[field])) return null
  }
  // Named through the report's own field rather than by importing the graph type,
  // which this module re-exports under the same name.
  return { graph: graph as ClientGraphReport['graph'], at }
}

export function apply(ctx: Context): void {
  // Optional, and the injection form is what makes it optional: a host without
  // this service simply never runs the callback, and the static bases above keep
  // answering for the checkout's own packages.
  ctx.inject(['profileContext'], (scope: Context) => {
    useProfileDirectory((scope as unknown as { profileContext: { dir: string } }).profileContext.dir)
  })

  ctx.inject(['loader', 'webServer'], (scope: Context) => {
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: GRAPH_PATH,
      handler: (_req, res) => {
        res.setHeader('content-type', 'application/json; charset=utf-8')
        // Collected once and read twice: the lookup is keyed by the names this
        // very graph carries, so building it from a second collection would be
        // answering about a composition that is a moment newer than the one sent.
        const graph = collectGraph(scope)
        res.end(JSON.stringify(applyDescriptions(graph, lookupFor(graph))))
      },
    }), 'plugin-graph: graph route')

    // The descriptions on their own, for the page's own tree: it collects the
    // browser graph itself and cannot read `node_modules`, but the packages are
    // the same ones. Same source as the field above — one cache, one answer.
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: DESCRIPTIONS_PATH,
      handler: (_req, res) => {
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify(lookupFor(collectGraph(scope))))
      },
    }), 'plugin-graph: descriptions route')

    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: VIEWER_PATH,
      handler: (req, res) => {
        res.setHeader('content-type', 'text/html; charset=utf-8')
        // The app puts its locale in this URL — the page has no locale service of
        // its own — and `viewerPage` validates it against the dictionaries before
        // it reaches the document. The base is a placeholder: only the query is
        // read, because a request target from the wire may be a path alone.
        const query = new URL(req.url ?? '/', 'http://localhost').searchParams
        res.end(viewerPage(query.get('lang')))
      },
    }), 'plugin-graph: viewer page')

    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: VIEWER_SCRIPT_PATH,
      handler: (_req, res) => {
        let script: string
        try {
          script = readFileSync(VIEWER_SCRIPT, 'utf8')
        } catch (error) {
          // A missing `viewer.js` means the plugin was installed without its
          // build output. Say so rather than serving an empty page that fails
          // with nothing in the console but a syntax error.
          res.statusCode = 500
          res.setHeader('content-type', 'text/plain; charset=utf-8')
          res.end(`plugin-graph: viewer script is not built at ${VIEWER_SCRIPT}\n${String(error)}`)
          return
        }
        res.setHeader('content-type', 'text/javascript; charset=utf-8')
        res.end(script)
      },
    }), 'plugin-graph: viewer script')

    // The design tokens the panel styles itself with — light and dark, both
    // from the theme package. Read per request like the viewer script, so a
    // rebuild takes effect on reload without a host restart.
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: THEME_CSS_PATH,
      handler: (_req, res) => {
        res.setHeader('content-type', 'text/css; charset=utf-8')
        res.end(readFileSync(THEME_CSS, 'utf8'))
      },
    }), 'plugin-graph: design tokens')

    // The browser half's tree, one way: the app POSTs what it collected, the
    // viewer GETs it. This exists because the standalone viewer is a document
    // this half serves and has no client Cordis of its own — the app is the only
    // half that can see that runtime, so it is the only half that can describe
    // it. A GET before any report is a 404 rather than an empty graph: "nobody
    // has looked yet" and "there is nothing there" are different answers.
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: CLIENT_GRAPH_PATH,
      handler: (req, res) => {
        if (req.method === 'GET') {
          if (clientReport === null) {
            res.statusCode = 404
            res.setHeader('content-type', 'text/plain; charset=utf-8')
            res.end('plugin-graph: no browser graph has been reported yet\n')
            return
          }
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.end(JSON.stringify(clientReport))
          return
        }
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end()
          return
        }
        let body = ''
        req.setEncoding('utf8')
        req.on('data', (chunk: string) => { body += chunk })
        req.on('end', () => {
          let report: ClientGraphReport | null = null
          try {
            report = asReport(JSON.parse(body) as unknown)
          } catch {
            report = null
          }
          if (report === null) {
            res.statusCode = 400
            res.end()
            return
          }
          clientReport = report
          res.statusCode = 204
          res.end()
        })
      },
    }), 'plugin-graph: client graph route')
  })
}
