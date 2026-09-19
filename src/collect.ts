/**
 * Collect a plugin dependency graph from ANY Cordis runtime.
 *
 * One implementation, two runtimes. The host half and the browser half are
 * different Cordis trees with different plugins and different service names — but
 * they are the SAME Cordis: `loader`, `registry`, `reflect` and `root` exist on
 * both, and everything below reads only those four. So the graph is assembled by
 * one function and called twice: once by the host's route, once by the browser
 * panel on its own `ctx.root`. Two copies of these rules would be two chances to
 * disagree about what a dependency is, which is the failure mode this project
 * keeps finding in hindsight.
 *
 * Extracted from the Node half because the browser bundle cannot import that
 * module: it pulls in `node:fs` and the webserver's Node-side types. Nothing here
 * does — it is Cordis and the wire types, which both halves already have.
 *
 * The rules below are each non-obvious and each was measured; their comments say
 * what went wrong when they were not followed.
 * @module dsh-plugin-graph/collect
 */
import type { Context, Fiber } from '@deepseek-ai/cordis'
// Type-only merge: pulls in `ctx.loader` without importing the Loader at runtime.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {
  GraphEdge, GraphInjection, GraphNode, IsolatedService, PluginGraph, UnresolvedDependency,
} from './graph-types.ts'

/**
 * Value mirror of Cordis's `FiberState` const enum.
 *
 * A const enum has no runtime object to import, so the numbers are restated here
 * rather than read from the module — the same reason `dsh-tool-cordis` carries a
 * mirror of its own.
 */
const STATE_LABELS: Record<number, string> = {
  0: 'pending',
  1: 'loading',
  2: 'active',
  3: 'failed',
  4: 'disposed',
  5: 'unloading',
}

/**
 * Synthetic node id standing for the root fiber.
 *
 * The root fiber provides the harness's own services (`loader`, `jobs`, `sandbox`,
 * the environment rows) and has no Loader entry to name it, so the graph gives it
 * a node of its own rather than dropping every edge that lands on it.
 */
const ROOT_NODE_ID = '(harness)'

/**
 * The id of the Loader entry that owns a fiber, in the spelling nodes use.
 *
 * The same walk as `loader.locate()` — and deliberately not a call to it, for
 * one reason: `locate()` returns `entry.id`, the qualified tree path, while a
 * node is keyed by `entry.options.id`. Those are different strings (`locate()`
 * answers `include:plugin-graph` for an entry whose `options.id` is
 * `plugin-graph`), so the two cannot be compared directly — doing so silently
 * drops every nested fiber into a bucket no node ever reads.
 *
 * The Loader stamps `fiber.entry` on a child fiber from its parent context, so
 * a nested fiber belongs to the same entry as the plugin that spawned it,
 * however deep the nesting goes. Parent-walking covers the rest.
 * @param fiber - any fiber in the composition.
 * @returns the owning entry's node id, or undefined when no entry owns it.
 */
function ownerNodeId(fiber: Fiber): string | undefined {
  let current: Fiber | undefined = fiber
  while (current !== undefined) {
    if (current.entry !== undefined) return current.entry.options.id
    const next: Fiber | undefined = current.parent?.fiber
    // The root fiber is its own parent; reaching it means the walk left the tree.
    if (next === undefined || next === current) return undefined
    current = next
  }
  return undefined
}

/**
 * Every live fiber in the composition, grouped by the id of the Loader entry
 * that owns it.
 *
 * `entry.fiber` is only the fiber the entry's own module started. A plugin can
 * start more at runtime — `ctx.plugin(...)`, and every `ctx.inject(deps, cb)`
 * call, which is that same call — and each of those children carries an `inject`
 * map of its own. Reading `entry.fiber` alone therefore reports a plugin's
 * declared requirements and silently drops everything it acquires at runtime,
 * which is how every optional contribution in this composition is written.
 *
 * The entry's own fiber is inserted first for every entry, so `[0]` is the
 * declaration that gates activation and the rest are runtime acquisitions.
 * @param ctx - a context with `loader` and `registry` in scope.
 * @returns node id → its fibers, the entry's own fiber first.
 */
function fibersByEntry(ctx: Context): Map<string, Fiber[]> {
  const byEntry = new Map<string, Fiber[]>()
  // UID, not object identity: `ctx` is a Proxy and `entry.fiber` is the
  // `Object.create` wrapper `registry.plugin()` returns, so one logical fiber is
  // reachable as two distinct objects. Same reason `ownerOfUid` below is keyed
  // by UID.
  const seen = new Set<number>()
  const add = (id: string | undefined, fiber: Fiber): void => {
    // A fiber with no entry behind it belongs to the RUNTIME — the same rule the
    // provider table below already uses (`record(name, owner ?? ROOT_NODE_ID)`).
    // Dropping it here instead meant one fiber could be half in the graph: its
    // service shown under `(harness)` while its injections and listeners went
    // silently missing.
    const owner = id ?? ROOT_NODE_ID
    if (typeof fiber.uid === 'number') {
      if (seen.has(fiber.uid)) return
      seen.add(fiber.uid)
    }
    const fibers = byEntry.get(owner) ?? []
    fibers.push(fiber)
    byEntry.set(owner, fibers)
  }
  for (const entry of ctx.loader.entries()) {
    if (entry.fiber !== undefined) add(entry.options.id, entry.fiber)
  }
  // Every live fiber, not just the entries' own: `registry.forEach` is the only
  // place that sees the fibers a plugin started after it was loaded.
  ctx.registry.forEach((runtime) => {
    for (const fiber of runtime.fibers) add(ownerNodeId(fiber), fiber)
  })
  return byEntry
}

/**
 * Event names each owner listens to, read from the dispatcher's own table.
 *
 * `ctx.events._hooks` is in no type declaration — the published API is dispatch
 * only (`emit` / `parallel` / `serial` / …) — but the implementation keeps one
 * list per event name, and every entry carries the CONTEXT that registered it
 * (`{ ctx, callback, prepend }`, measured). That context's fiber is therefore
 * the same owner a service's provider resolves to, so this walk reuses
 * {@link ownerNodeId} rather than inventing a second rule for "whose plugin is
 * this".
 *
 * `internal/*` is dropped: those are the framework's own hooks (hot reload, the
 * listener bookkeeping itself), not what a reader means by "this plugin listens
 * to". Names are deduped per owner and kept in registration order.
 *
 * What this CANNOT report is the other direction — who EMITS a name. Dispatch
 * reads the table and never writes a publisher down, so there is nothing to
 * enumerate; `GraphNode.listens` is named to say which half this is.
 * @param ctx - a context with `events` in scope.
 * @returns node id → event names.
 */
function eventsByOwner(ctx: Context): Map<string, string[]> {
  const events = (ctx as unknown as {
    events?: { _hooks?: Record<string, { ctx?: Context }[]> }
  }).events
  const byOwner = new Map<string, string[]>()
  for (const [name, hooks] of Object.entries(events?._hooks ?? {})) {
    if (name.startsWith('internal/')) continue
    for (const hook of hooks) {
      const fiber = (hook.ctx as unknown as { fiber?: Fiber } | undefined)?.fiber
      const owner = (fiber === undefined ? undefined : ownerNodeId(fiber)) ?? ROOT_NODE_ID
      const names = byOwner.get(owner) ?? []
      if (!names.includes(name)) names.push(name)
      byOwner.set(owner, names)
    }
  }
  return byOwner
}

/**
 * Collect a runtime's plugin dependency graph.
 *
 * Called with the HOST root context by the Node half's route, and with the
 * BROWSER root context by the client panel. The two graphs are not comparable and
 * must not be merged: the browser is a different Cordis tree with its own
 * `reflect` and its own service names, so a merged graph would not be a bigger
 * one, it would be a wrong one.
 * @param ctx - the runtime's root context (or one with `loader` and `reflect`).
 * @returns the graph a panel renders.
 */
export function collectGraph(ctx: Context): PluginGraph {
  const entries = [...ctx.loader.entries()]

  // fiber uid → entry id. Matched by UID rather than by object identity: `ctx` is
  // a Proxy, so the fiber reachable from an entry and the fiber recorded on an
  // implementation are the same logical fiber without being the same object.
  const ownerOfUid = new Map<number, string>()
  for (const entry of entries) {
    const uid = entry.fiber?.uid
    if (typeof uid === 'number') ownerOfUid.set(uid, entry.options.id)
  }

  // Services by owner, and owners by service, filled from the authoritative list.
  //
  // `reflect.store` is that list. It is keyed by isolation SYMBOL — which is what
  // resolving one name to its realm needs — so the service name comes from the
  // record rather than from the key. `fiber.store` is the wrong source here: it
  // also holds the implementations a fiber merely DEPENDS on, which would report
  // every consumer of `fs` as a provider of it.
  const providersByName = new Map<string, string[]>()
  const servicesOfOwner = new Map<string, string[]>()
  const record = (service: string, owner: string): void => {
    const owners = providersByName.get(service) ?? []
    if (!owners.includes(owner)) owners.push(owner)
    providersByName.set(service, owners)
    const provided = servicesOfOwner.get(owner) ?? []
    if (!provided.includes(service)) provided.push(service)
    servicesOfOwner.set(owner, provided)
  }

  const store = ctx.reflect.store as Record<symbol, { name: string; fiber: Fiber } | undefined>
  for (const symbol of Object.getOwnPropertySymbols(store)) {
    const impl = store[symbol]
    if (impl === undefined) continue
    const uid = impl.fiber.uid
    // A provider with no entry is the runtime itself: the root fiber, and the
    // Loader's own fiber. They get the synthetic node rather than being dropped,
    // which is what keeps `loader` and the environment rows from reading as
    // unresolved dependencies of everything that injects them.
    const owner = typeof uid === 'number' ? ownerOfUid.get(uid) : undefined
    record(impl.name, owner ?? ROOT_NODE_ID)
  }

  // What each entry injects, split by what the declaration gates. Both halves
  // are real dependencies and both get edges; the split decides only whether a
  // missing provider is reported as a fault.
  const fibersOf = fibersByEntry(ctx)
  const injectionsOf = (id: string): GraphInjection[] => {
    const [own, ...nested] = fibersOf.get(id) ?? []
    const injections: GraphInjection[] = Object.keys(own?.inject ?? {})
      .map(service => ({ service, optional: false }))
    for (const fiber of nested) {
      for (const service of Object.keys(fiber.inject)) {
        // Required wins when both declarations name the same service: the
        // stricter one is the one that decides whether the plugin loads.
        if (injections.some(injection => injection.service === service)) continue
        injections.push({ service, optional: true })
      }
    }
    return injections
  }
  // An entry that never loaded has no fibers, and therefore no injections —
  // which replaces a separate `entry.fiber === undefined` guard on the edge loop.
  const injectionsById = new Map<string, GraphInjection[]>(
    entries.map(entry => [entry.options.id, injectionsOf(entry.options.id)]),
  )

  const listensOf = eventsByOwner(ctx)

  const nodes: GraphNode[] = entries.map(entry => ({
    id: entry.options.id,
    name: entry.options.name,
    state: entry.fiber === undefined
      ? 'unloaded'
      : (STATE_LABELS[entry.fiber.state as number] ?? String(entry.fiber.state)),
    provides: servicesOfOwner.get(entry.options.id) ?? [],
    injects: injectionsById.get(entry.options.id) ?? [],
    listens: listensOf.get(entry.options.id) ?? [],
  }))

  const harnessServices = servicesOfOwner.get(ROOT_NODE_ID) ?? []
  if (harnessServices.length > 0) {
    nodes.push({
      id: ROOT_NODE_ID,
      name: ROOT_NODE_ID,
      state: 'active',
      provides: harnessServices,
      // Through the same reader every other node uses, rather than reading the
      // root fiber directly: the `(harness)` bucket now holds every fiber that
      // belongs to no entry — the root's own and any anonymous ones — and the
      // root fiber is inside it, so this is a superset of what the direct read
      // produced. One rule for "what does this node inject".
      injects: injectionsById.get(ROOT_NODE_ID) ?? [],
      listens: listensOf.get(ROOT_NODE_ID) ?? [],
    })
  }

  const edges: GraphEdge[] = []
  const unresolved: UnresolvedDependency[] = []
  for (const entry of entries) {
    const id = entry.options.id
    for (const { service, optional } of injectionsById.get(id) ?? []) {
      const providers = providersByName.get(service)
      if (providers === undefined || providers.length === 0) {
        // Only a required service with no provider is a fault. An optional one
        // that nothing provides is the ordinary resting state of the callback
        // form: that contribution stays unloaded and the plugin is fine.
        if (!optional) unresolved.push({ from: id, service })
        continue
      }
      // One edge per provider: an isolated service legitimately has several, and
      // keeping only the first would hide exactly what `isolate` was for.
      for (const providerId of providers) {
        edges.push({ from: id, to: providerId, service, optional })
      }
    }
  }

  const isolated: IsolatedService[] = [...providersByName.entries()]
    .filter(([, providers]) => providers.length > 1)
    .map(([service, providers]) => ({ service, providers }))

  return { nodes, edges, unresolved, isolated }
}
