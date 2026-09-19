/**
 * The dependency graph's wire shape, shared by both halves.
 *
 * A separate module rather than types living in the Node half: the browser bundle
 * cannot import `src/index.ts` (that module pulls in cordis and the webserver's
 * Node-side types), and restating the shape on the browser side is exactly how two
 * definitions of one wire format start to drift.
 *
 * Types only, plus the one path constant both halves must agree on.
 */

/** Path the graph is served at, shared so neither half restates it. */
export const GRAPH_PATH = '/dsh-plugin-graph'

/**
 * Path of the standalone viewer page.
 *
 * Served by the Node half as a whole document rather than by the module loader,
 * because its whole point is to escape the settings panel: an iframe or a route
 * inside the app would inherit the same width the reader is trying to get away
 * from.
 */
export const VIEWER_PATH = '/dsh-plugin-graph/view'

/** Path of the viewer's script, served beside its page and referenced by it. */
export const VIEWER_SCRIPT_PATH = '/dsh-plugin-graph/viewer.js'

/**
 * Path of the design tokens, served beside the viewer page.
 *
 * The panel styles itself with the app's `--dsw-*` custom properties, which the
 * app's theme defines — the same file the app loads, copied here at build time so
 * the two surfaces share one source of truth. The served page keeps a small
 * fallback of its own for the case where this file is missing.
 */
export const THEME_CSS_PATH = '/dsh-plugin-graph/theme.css'

/**
 * Path the browser half reports its graph to, and the viewer reads it from.
 *
 * One path, two methods: the app POSTs what it collected, the viewer GETs it. The
 * handoff exists because the standalone viewer is a document the Node half serves
 * and has no client Cordis of its own — the app is the only half that can see that
 * runtime, so it is the only half that can describe it.
 */
export const CLIENT_GRAPH_PATH = '/dsh-plugin-graph/client'

/**
 * Path the package descriptions are served at.
 *
 * A route of its own rather than a field on the graph, because the caller that
 * needs it is the page: it collects the BROWSER tree itself and has no host graph
 * in hand to read descriptions off, yet the packages on that side are the same
 * ones — only `node_modules` is somewhere the page cannot look.
 */
export const DESCRIPTIONS_PATH = '/dsh-plugin-graph/descriptions'

/**
 * One service a plugin injects, and what its declaration gates.
 *
 * A plugin can acquire services two ways, and the difference is not cosmetic:
 *
 * - declared on the plugin itself (`export const inject = [...]`, an entry
 *   `inject:` option, or the `@Inject` decorator) — the fiber stays pending
 *   until every one of them resolves, so the plugin does not load without them;
 * - acquired at runtime through the `ctx.inject(deps, callback)` helper — the
 *   callback runs once they appear, so the plugin loads either way and only
 *   that contribution waits.
 *
 * Both are real dependencies and both get edges. `optional` carries which kind,
 * because a missing required service is a broken composition while a missing
 * optional one is the ordinary case the callback form exists for.
 */
export interface GraphInjection {
  /** The service name as it is registered in Cordis. */
  readonly service: string
  /**
   * True when the plugin only acquires this service at runtime, so its absence
   * leaves that one contribution unloaded rather than failing the plugin.
   */
  readonly optional: boolean
}

/** One plugin's row in the graph. */
export interface GraphNode {
  /** The Loader entry's stable id. */
  readonly id: string
  /** The package or module name the entry loaded. */
  readonly name: string
  /** Lifecycle state as a label; `unloaded` when the entry has no fiber at all. */
  readonly state: string
  /** Services this plugin provides. */
  readonly provides: readonly string[]
  /**
   * Every service this plugin injects, by either declaration style — the union
   * across the entry's own fiber and every fiber it started at runtime.
   */
  readonly injects: readonly GraphInjection[]
  /**
   * Event names this plugin listens to.
   *
   * One direction only, and named for it: the dispatcher keeps a table of
   * listeners (see `collect.ts`), so who LISTENS is knowable, while who EMITS a
   * name is not — dispatch never records a publisher. `listens` says which of the
   * two this is, where a field called `events` would let a reader assume both.
   */
  readonly listens: readonly string[]
  /**
   * The package's own `package.json` description, when it has one.
   *
   * Absent rather than empty when the package does not say, or when nothing could
   * read it — a virtual entry, a built-in, a path that does not resolve. The
   * detail panel draws no line at all in that case: "this package does not
   * describe itself" is a fact about the package, and an empty box would be a
   * fact about us.
   *
   * Filled by the NODE half (`./describe.ts` explains the split), so a graph
   * fetched from the route always carries whatever could be read; the browser
   * tree gets them from the same route.
   */
  readonly description?: string
}

/** One dependency edge: the consumer injecting `service`, and the provider. */
export interface GraphEdge {
  /** Consumer entry id. */
  readonly from: string
  /** Provider entry id. */
  readonly to: string
  /** The service that makes the edge. */
  readonly service: string
  /** Mirrors {@link GraphInjection.optional} for the service that makes this edge. */
  readonly optional: boolean
}

/**
 * One REQUIRED injected service with no provider anywhere in this composition.
 *
 * Only required injections are listed: an optional one with no provider has
 * simply not been offered yet, and the plugin is working as designed.
 */
export interface UnresolvedDependency {
  /** The consumer that asked for it. */
  readonly from: string
  /** The service name nothing provides. */
  readonly service: string
}

/** One service with more than one live implementation, i.e. an isolated one. */
export interface IsolatedService {
  /** The service name shared by the implementations. */
  readonly service: string
  /** Entry ids providing it, one per isolation label. */
  readonly providers: readonly string[]
}

/**
 * The browser half's graph, as reported for the standalone viewer to show.
 *
 * A snapshot WITH the instant it was taken, not a live read: the viewer cannot
 * collect this tree itself, so what it shows is "the browser runtime as of the
 * last time the app looked". Printing that instant is the difference between
 * a snapshot and a lie — a graph a reader believes is current but is not.
 */
export interface ClientGraphReport {
  readonly graph: PluginGraph
  /** When the app collected it, epoch milliseconds. */
  readonly at: number
}

/** The whole graph, as the browser half reads it. */
export interface PluginGraph {
  /** Every Loader entry, in load order. */
  readonly nodes: readonly GraphNode[]
  /** Every resolved dependency. */
  readonly edges: readonly GraphEdge[]
  /** Injections no provider answers. */
  readonly unresolved: readonly UnresolvedDependency[]
  /** Services provided under more than one isolation label. */
  readonly isolated: readonly IsolatedService[]
}
