/**
 * The dependency-graph panel: fetch, stats, the drawing, the detail, the problems.
 *
 * Read-only by design: the graph answers "who needs whom", and nothing here is a
 * control. It is DRAWN (see ./graph-canvas.tsx) rather than listed, because the
 * question is structural — which few services hold the whole composition
 * together — and a list answers that one row at a time, at the cost of the shape.
 *
 * The two halves split the work: the drawing says WHICH node, the detail panel
 * says which service, in which direction, and whether the declaration gates
 * activation. Neither replaces the other.
 *
 * This module is the PANEL, not a host. Two hosts render it: the in-app settings
 * section (./index.ts, mounted through the slot renderer) and the standalone page
 * (../viewer/main.tsx, served whole by the Node half). The one thing they
 * disagree about is the "open in a new tab" button, which is what `viewerPath`
 * selects — the viewer does not link to itself.
 *
 * The graph is fetched rather than pushed: it is a JSON snapshot with no delta
 * contract worth owning, and a panel that reads it on mount is always current
 * when opened.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import {
  CLIENT_GRAPH_PATH,
  DESCRIPTIONS_PATH,
  GRAPH_PATH,
  type ClientGraphReport, type GraphEdge, type GraphInjection, type GraphNode, type PluginGraph,
} from '../graph-types.ts'
import { applyDescriptions } from '../describe.ts'
import { GraphCanvas, stateColor, stateLabel, type GraphCanvasProps } from './graph-canvas.tsx'
import type { Translate } from './locales.ts'

/** Which runtime's tree is on screen. */
type Scope = 'host' | 'client'

/** Props the two hosts bind for this panel. */
export interface GraphPanelProps {
  /** Locale-bound translate. */
  readonly t: Translate
  /** Path of the standalone viewer, or null to omit the button that opens it. */
  readonly viewerPath: string | null
  /**
   * Collect the BROWSER half's graph, or undefined where there is no browser tree.
   *
   * The two trees are separate on purpose and must never be merged: they are
   * different Cordis runtimes with different plugins and different service names,
   * so one merged graph would not be a bigger one, it would be a wrong one. That
   * is why this is a second SOURCE rather than a second set of nodes.
   *
   * Absent in the standalone viewer: that page is served by the Node half and has
   * no client Cordis of its own, so it can only show the host's graph.
   */
  readonly clientGraph?: () => PluginGraph
  /**
   * When the supplied browser graph was collected, or null/undefined when unknown.
   *
   * Shown beside the browser graph because that graph may be a SNAPSHOT rather
   * than a live read — in the standalone viewer it always is, since that page
   * cannot collect the tree itself. A graph a reader believes is current but is
   * not is worse than one that admits its age.
   */
  readonly clientGraphAt?: number | null
  /**
   * Height of the drawing area in px, or undefined for the canvas's own default.
   * The viewer sizes it to the window; a settings column wants a fixed panel.
   */
  readonly canvasHeight?: number
  /**
   * The app's current locale id, or undefined where nothing can answer for it.
   *
   * A FUNCTION, not a value, because the reader can switch language while this
   * panel is mounted: a captured string would open the viewer in the language the
   * app happened to be in when the settings section first appeared. Absent in the
   * standalone viewer itself, which has no locale service to ask — and no button
   * to open, since it passes `viewerPath: null`.
   */
  readonly activeLocale?: () => string
}

/**
 * Descriptions by package name, fetched at most once per page.
 *
 * The HOST graph arrives already described; the BROWSER one is collected in this
 * page, so its packages need this to be described too. A description cannot change
 * while the page is open — it comes from a `package.json` on disk — so one request
 * answers every refresh, and a failed one is retried rather than cached: a page
 * that lost descriptions to one transient failure would keep missing them until
 * it was reloaded.
 */
let pendingDescriptions: Promise<Record<string, string>> | null = null

async function descriptions(): Promise<Record<string, string>> {
  pendingDescriptions ??= fetch(DESCRIPTIONS_PATH, { cache: 'no-store' })
    .then(async (response) => (response.ok ? (await response.json()) as Record<string, string> : {}))
    .catch(() => {
      pendingDescriptions = null
      return {}
    })
  return pendingDescriptions
}

/**
 * The selected node, plus the trail of nodes visited to reach it.
 *
 * Browser semantics, deliberately: `select` truncates anything ahead of the
 * current position before appending, so going back and then choosing something
 * new drops the forward entries — that history described a path the reader just
 * chose not to take. `null` is a step like any other, so backing out of a node
 * and coming forward again returns to that node.
 *
 * Trail and cursor live in ONE state object rather than two: a pair of
 * `useState`s would be a re-render apart from each other, and every consumer
 * would have to defend against a cursor pointing off the end of a trail it
 * never saw.
 * @returns the current node, the three actions, and whether each is available.
 */
function useSelectionHistory(): {
  readonly current: string | null
  readonly select: (id: string | null) => void
  readonly back: () => void
  readonly forward: () => void
  readonly canBack: boolean
  readonly canForward: boolean
} {
  const [history, setHistory] = useState<{ trail: (string | null)[]; at: number }>({
    trail: [null],
    at: 0,
  })
  const select = useCallback((id: string | null): void => {
    setHistory((current) => {
      // Re-selecting what is already current is not a step: a stray click on the
      // background would otherwise fill the trail with `null`s and make Back look
      // broken by doing nothing visible.
      if (current.trail[current.at] === id) return current
      const trail = current.trail.slice(0, current.at + 1)
      trail.push(id)
      return { trail, at: trail.length - 1 }
    })
  }, [])
  const back = useCallback((): void => {
    setHistory(current => (current.at === 0 ? current : { ...current, at: current.at - 1 }))
  }, [])
  const forward = useCallback((): void => {
    setHistory(current =>
      (current.at >= current.trail.length - 1 ? current : { ...current, at: current.at + 1 }))
  }, [])
  return {
    current: history.trail[history.at] ?? null,
    select,
    back,
    forward,
    canBack: history.at > 0,
    canForward: history.at < history.trail.length - 1,
  }
}

/** What the panel is currently showing. */
type Load =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'ready'; readonly graph: PluginGraph }

export function GraphPanel({
  t, viewerPath, clientGraph, clientGraphAt, canvasHeight, activeLocale,
}: GraphPanelProps): ReactNode {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const { current: selected, select, back, forward, canBack, canForward } = useSelectionHistory()
  const [scope, setScope] = useState<Scope>('host')

  const refresh = useCallback((): void => {
    // Keep whatever is on screen while re-reading. Blanking the panel UNMOUNTS the
    // canvas, and the canvas can be the fullscreen element -- the browser exits
    // fullscreen the moment its element leaves the document, which is exactly the
    // "clicked fullscreen and it came straight back" that was reported. A graph
    // already on screen is also better than a spinner between two identical reads.
    setLoad(current => (current.kind === 'ready' ? current : { kind: 'loading' }))
    void (async () => {
      try {
        // Whichever half has the tree assembles it, and both call the same
        // `collectGraph`: the host's is FETCHED because the browser cannot see
        // that runtime, and the browser's is COLLECTED here because the host
        // cannot see this one.
        const graph = scope === 'client' && clientGraph !== undefined
          // The one read that has to be completed here: the host's graph comes
          // described, and this one was assembled in the page.
          ? applyDescriptions(clientGraph(), await descriptions())
          : await fetch(GRAPH_PATH, { cache: 'no-store' }).then(async (response) => {
            if (!response.ok) throw new Error(`plugin graph: HTTP ${String(response.status)}`)
            return (await response.json()) as PluginGraph
          })
        setLoad({ kind: 'ready', graph })
      } catch {
        // The route is registered by the Node half; a failure here means it is not
        // mounted, and the section says so rather than showing an empty graph —
        // "no plugins" and "cannot ask" are different answers.
        setLoad({ kind: 'failed' })
      }
    })()
    // Re-reads when the scope changes, because `refresh` is that scope's read.
  }, [scope, clientGraph])

  /**
   * Hand the browser tree to the host, so the standalone viewer can show it.
   *
   * Fire and forget: this view already has the graph on screen, and the report
   * only reaches a page the reader may open later — a failure changes nothing
   * here, so there is nothing worth telling anyone about it.
   */
  const reportClientGraph = useCallback((graph: PluginGraph): void => {
    const report: ClientGraphReport = { graph, at: Date.now() }
    void fetch(CLIENT_GRAPH_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report),
    }).catch(() => undefined)
  }, [])

  // Reported on mount and on every browser-scope read. The viewer is opened from
  // this panel, and it should not have to wait for a second visit before it has
  // anything to show — but it also must not show a tree older than the last one
  // the reader actually looked at here.
  useEffect(() => {
    if (clientGraph === undefined || scope !== 'host') return
    try {
      reportClientGraph(clientGraph())
    } catch {
      // A collector that throws leaves this panel exactly as it was; the report is
      // for another page, not for this one.
    }
  }, [clientGraph, reportClientGraph, scope])

  useEffect(() => { refresh() }, [refresh])

  /**
   * The controls, built ONCE and rendered twice: here in the header, and handed
   * to the canvas for fullscreen to draw.
   *
   * One set of elements, not two that drift: `scope` and `refresh` belong to this
   * component, and a copy assembled inside the canvas would need them passed down
   * anyway — at which point it is the same elements with an extra step. Outside
   * fullscreen the canvas does not draw its copy at all, so a reader never sees
   * these buttons twice.
   */
  const actions = (
    <>
      {/* Only where there are two trees to choose between. The two buttons
          sit together because they are one choice — the viewer, which has
          only the host's graph, shows neither. */}
      {clientGraph !== undefined && (
        <>
          <button
            type="button"
            aria-pressed={scope === 'host'}
            style={SCOPE_STYLE(scope === 'host')}
            onClick={() => { setScope('host') }}
          >
            {t('scopeHost')}
          </button>
          <button
            type="button"
            aria-pressed={scope === 'client'}
            style={SCOPE_STYLE(scope === 'client')}
            onClick={() => { setScope('client') }}
          >
            {t('scopeClient')}
          </button>
        </>
      )}
      {viewerPath !== null && (
        <button
          type="button"
          style={REFRESH_STYLE}
          // `noopener`: same-origin, but a fresh document has no business
          // reaching back through `window.opener`. The scheme AND the locale
          // travel in the URL because the viewer cannot read this runtime's
          // theme or its locale service: it is a page the Node half serves,
          // with no cordis running on it. Read at CLICK time so a language the
          // reader switched to a moment ago is the one the new tab opens in.
          onClick={() => {
            const dark = document.body.hasAttribute('data-ds-dark-theme')
            const lang = activeLocale === undefined ? null : activeLocale()
            const query = new URLSearchParams({ scheme: dark ? 'dark' : 'light' })
            if (lang !== null) query.set('lang', lang)
            window.open(`${viewerPath}?${query.toString()}`, '_blank', 'noopener')
          }}
        >
          {t('openInTab')}
        </button>
      )}
      <button type="button" style={REFRESH_STYLE} onClick={refresh}>{t('refresh')}</button>
    </>
  )

  return (
    <div style={ROOT_STYLE}>
      <div style={HEADER_STYLE}>
        <h2 style={HEADING_STYLE}>{t('title')}</h2>
        <div style={HEADER_ACTIONS_STYLE}>{actions}</div>
      </div>
      <p style={INTRO_STYLE}>{scope === 'client' ? t('introClient') : t('intro')}</p>
      {/* The age of a snapshot, stated where it is read rather than left to be
          assumed: the viewer's copy is always one the app collected earlier. */}
      {scope === 'client' && clientGraphAt !== undefined && clientGraphAt !== null && (
        <p style={MUTED_STYLE}>{t('clientCollectedAt', { when: new Date(clientGraphAt).toLocaleString() })}</p>
      )}
      {load.kind === 'loading' && <p style={MUTED_STYLE}>{t('loading')}</p>}
      {load.kind === 'failed' && <p style={FAILED_STYLE}>{t('failed')}</p>}
      {load.kind === 'ready' && (
        <Ready
          graph={load.graph}
          selected={selected}
          onSelect={select}
          t={t}
          canvasHeight={canvasHeight}
          actions={actions}
          history={{ canBack, canForward, onBack: back, onForward: forward }}
        />
      )}
    </div>
  )
}

/** The loaded view: stats, the drawing with its detail panel, and the problems. */
function Ready({ graph, selected, onSelect, t, canvasHeight, actions, history }: {
  readonly graph: PluginGraph
  readonly selected: string | null
  readonly onSelect: (id: string | null) => void
  readonly t: Translate
  readonly canvasHeight?: number
  /** The panel's controls, for the canvas to draw while it is fullscreen. */
  readonly actions: ReactNode
  /** Selection history, for the canvas's back and forward buttons. */
  readonly history: GraphCanvasProps['history']
}): ReactNode {
  const node = graph.nodes.find(candidate => candidate.id === selected) ?? null
  const [filter, setFilter] = useState<string | null>(null)
  // A filter naming a state this graph does not have — after a refresh, or a
  // scope switch — would dim the whole drawing with nothing on screen saying
  // why. Dropped here rather than in an effect: it is a render decision, and an
  // effect would paint the all-dim frame first.
  const states = new Set(graph.nodes.map(candidate => candidate.state))
  const active = filter !== null && states.has(filter) ? filter : null
  // What the canvas draws while it is fullscreen: the header's controls and the
  // status row, which are exactly the things a fullscreen reader loses and the
  // things they reach for most — switching trees, refreshing, narrowing to one
  // state. Built from the same state this component holds, so the status row in
  // the canvas and the one above it are never out of step.
  const toolbar = (
    <div style={TOOLBAR_STYLE}>
      {actions}
      <StatusBar graph={graph} filter={active} onFilter={setFilter} t={t} />
    </div>
  )
  return (
    <>
      <div style={STATS_STYLE}>
        <Chip text={t('statPlugins', { value: graph.nodes.length })} />
        <Chip text={t('statEdges', { value: graph.edges.length })} />
        {graph.unresolved.length > 0 && (
          <Chip text={t('statUnresolved', { value: graph.unresolved.length })} warn />
        )}
      </div>
      <StatusBar graph={graph} filter={active} onFilter={setFilter} t={t} />
      <div style={COLUMNS_STYLE}>
        <section style={CANVAS_COLUMN_STYLE}>
          <h3 style={SUBHEADING_STYLE}>{t('sectionGraph')}</h3>
          <GraphCanvas
            graph={graph}
            selected={selected}
            onSelect={onSelect}
            t={t}
            height={canvasHeight}
            filter={active}
            toolbar={toolbar}
            history={history}
            // The same element the column beside it renders: fullscreen draws it
            // over the canvas instead, because the column is not on screen there.
            detail={node === null ? undefined : <Detail graph={graph} node={node} onSelect={onSelect} t={t} />}
          />
        </section>
        <section style={COLUMN_STYLE}>
          <h3 style={SUBHEADING_STYLE}>{t('sectionDetail')}</h3>
          {node === null
            ? <p style={MUTED_STYLE}>{t('selectHint')}</p>
            : <Detail graph={graph} node={node} onSelect={onSelect} t={t} />}
        </section>
      </div>
      <Problems graph={graph} t={t} />
    </>
  )
}

function Chip({ text, warn = false }: { readonly text: string; readonly warn?: boolean }): ReactNode {
  return <span style={warn ? CHIP_WARN_STYLE : CHIP_STYLE}>{text}</span>
}

/** One plugin's services and its edges in both directions. */
function Detail({ graph, node, onSelect, t }: {
  readonly graph: PluginGraph
  readonly node: GraphNode
  readonly onSelect: (id: string) => void
  readonly t: Translate
}): ReactNode {
  const byId = new Map(graph.nodes.map(candidate => [candidate.id, candidate]))
  // The two declaration styles are listed apart rather than mixed with a marker
  // on each tag: they answer different questions, and a reader asking "why did
  // this plugin not load" wants only the first list.
  const runtime = injectedServices(node.injects, true)
  // Edges are directed consumer → provider, so "what I depend on" is the outgoing
  // side and "what depends on me" is the incoming one. Both are shown because a
  // hub plugin is interesting for the second and a misbehaving one for the first.
  return (
    <div>
      <div style={DETAIL_HEAD_STYLE}>
        <span style={DETAIL_NAME_STYLE}>{node.name}</span>
        <span style={DETAIL_ID_STYLE}>{node.id} · {stateLabel(node.state, t)}</span>
      </div>
      {/* The package's own words, when it has any: a reader asking "what is this
          plugin" should not have to infer it from a name. No line at all when the
          package does not describe itself — see `GraphNode.description`. */}
      {node.description !== undefined && (
        <p style={DESCRIPTION_STYLE}>{node.description}</p>
      )}
      <ServiceList title={t('provides')} empty={t('nothingProvides')} values={node.provides} />
      {/* What it listens to, beside what it provides: both are things the plugin
          puts into (or takes from) the service and event fabric around it, and
          both come from the runtime rather than from the plugin's own source. */}
      <ServiceList title={t('listens')} empty={t('nothingListens')} values={node.listens} />
      <ServiceList
        title={t('injects')}
        empty={t('nothingInjects')}
        values={injectedServices(node.injects, false)}
      />
      {/* Always present when there is something to say, rather than a permanent
          empty block: most plugins never acquire anything at runtime. */}
      {runtime.length > 0 && (
        <ServiceList
          title={t('injectsOptional')}
          empty={t('nothingInjectsOptional')}
          values={runtime}
        />
      )}
      <EdgeList
        title={t('dependsOn')}
        empty={t('noDependsOn')}
        edges={graph.edges.filter(edge => edge.from === node.id)}
        side="to"
        byId={byId}
        onSelect={onSelect}
        optionalLabel={t('optionalMark')}
      />
      <EdgeList
        title={t('usedBy')}
        empty={t('noUsedBy')}
        edges={graph.edges.filter(edge => edge.to === node.id)}
        side="from"
        byId={byId}
        onSelect={onSelect}
        optionalLabel={t('optionalMark')}
      />
    </div>
  )
}

/**
 * Names of the injections on one side of the required / runtime split.
 * @param injections - one node's injection list.
 * @param optional - which side to select.
 * @returns the matching service names, in declaration order.
 */
function injectedServices(injections: readonly GraphInjection[], optional: boolean): string[] {
  return injections
    .filter(injection => injection.optional === optional)
    .map(injection => injection.service)
}

/** A plain list of service names. */
function ServiceList({ title, empty, values }: {
  readonly title: string
  readonly empty: string
  readonly values: readonly string[]
}): ReactNode {
  return (
    <div style={BLOCK_STYLE}>
      <div style={BLOCK_TITLE_STYLE}>{title}</div>
      {values.length === 0
        ? <div style={MUTED_SMALL_STYLE}>{empty}</div>
        : (
          <div style={TAGS_STYLE}>
            {values.map(value => <span key={value} style={TAG_STYLE}>{value}</span>)}
          </div>
        )}
    </div>
  )
}

/** Adjacent plugins, each row naming the service that makes the edge. */
function EdgeList({ title, empty, edges, side, byId, onSelect, optionalLabel }: {
  readonly title: string
  readonly empty: string
  readonly edges: readonly GraphEdge[]
  readonly side: 'from' | 'to'
  readonly byId: ReadonlyMap<string, GraphNode>
  readonly onSelect: (id: string) => void
  /** Badge shown on a runtime-acquired edge; absent on a declared one. */
  readonly optionalLabel: string
}): ReactNode {
  return (
    <div style={BLOCK_STYLE}>
      <div style={BLOCK_TITLE_STYLE}>{title}</div>
      {edges.length === 0
        ? <div style={MUTED_SMALL_STYLE}>{empty}</div>
        : (
          <ul style={PLAIN_LIST_STYLE}>
            {edges.map(edge => {
              const otherId = side === 'to' ? edge.to : edge.from
              return (
                <li key={`${edge.from}|${edge.to}|${edge.service}`}>
                  <button type="button" style={EDGE_ROW_STYLE} onClick={() => { onSelect(otherId) }}>
                    <span style={EDGE_SERVICE_STYLE}>{edge.service}</span>
                    {edge.optional && <span style={OPTIONAL_MARK_STYLE}>{optionalLabel}</span>}
                    <span style={EDGE_ARROW_STYLE}>{side === 'to' ? '→' : '←'}</span>
                    <span style={EDGE_NAME_STYLE}>{byId.get(otherId)?.name ?? otherId}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
    </div>
  )
}

/** The two things a reader may need to act on. */
function Problems({ graph, t }: {
  readonly graph: PluginGraph
  readonly t: Translate
}): ReactNode {
  return (
    <div style={BLOCK_STYLE}>
      <div style={BLOCK_TITLE_STYLE}>{t('unresolvedTitle')}</div>
      {graph.unresolved.length === 0
        ? <div style={MUTED_SMALL_STYLE}>{t('unresolvedNone')}</div>
        : (
          <ul style={PLAIN_LIST_STYLE}>
            {graph.unresolved.map(item => (
              <li key={`${item.from}|${item.service}`} style={PROBLEM_ROW_STYLE}>
                <span style={EDGE_SERVICE_STYLE}>{item.service}</span>
                <span style={EDGE_ARROW_STYLE}>←</span>
                <span style={EDGE_NAME_STYLE}>{item.from}</span>
              </li>
            ))}
          </ul>
        )}
      <div style={{ ...BLOCK_TITLE_STYLE, marginTop: 12 }}>{t('isolatedTitle')}</div>
      {graph.isolated.length === 0
        ? <div style={MUTED_SMALL_STYLE}>{t('isolatedNone')}</div>
        : (
          <ul style={PLAIN_LIST_STYLE}>
            {graph.isolated.map(item => (
              <li key={item.service} style={PROBLEM_ROW_STYLE}>
                <span style={EDGE_SERVICE_STYLE}>{item.service}</span>
                <span style={EDGE_ARROW_STYLE}>×{item.providers.length}</span>
                <span style={EDGE_NAME_STYLE}>{item.providers.join(', ')}</span>
              </li>
            ))}
          </ul>
        )}
    </div>
  )
}

/** The lifecycle's own order: the two that decide loading first, then the rest. */
const STATE_ORDER = ['active', 'failed', 'pending', 'loading', 'unloading', 'disposed', 'unloaded']

/**
 * The status row: which states this graph has, how many nodes are in each, and a
 * filter on one of them.
 *
 * A legend, a census and a control in one line, because they answer one question
 * three ways: the dot says which colour means what — the canvas has been
 * colouring nodes by state all along and nothing on screen said so — the count
 * says how much of the graph is in that state, and the click narrows the drawing
 * to it.
 *
 * Only the states the graph actually has, and in a FIXED order rather than sorted
 * by count: buttons that reorder themselves under the pointer when a refresh
 * changes the numbers are worse than ones with a gap. Clicking the state already
 * showing turns the filter off, which is the only way back to everything — a
 * "show all" button would be a sixth control saying what clicking again already
 * says.
 */
function StatusBar({ graph, filter, onFilter, t }: {
  readonly graph: PluginGraph
  readonly filter: string | null
  readonly onFilter: (state: string | null) => void
  readonly t: Translate
}): ReactNode {
  const counts = new Map<string, number>()
  for (const node of graph.nodes) counts.set(node.state, (counts.get(node.state) ?? 0) + 1)
  const present = STATE_ORDER.filter(state => (counts.get(state) ?? 0) > 0)
  if (present.length === 0) return null
  return (
    <div style={STATUS_STYLE}>
      <span style={BLOCK_TITLE_STYLE}>{t('statusTitle')}</span>
      {present.map(state => (
        <button
          key={state}
          type="button"
          aria-pressed={filter === state}
          onClick={() => { onFilter(filter === state ? null : state) }}
          style={STATUS_BUTTON_STYLE(filter === state)}
        >
          <span style={{ ...STATUS_DOT_STYLE, background: stateColor(state) }} />
          {stateLabel(state, t)}
          <span style={STATUS_COUNT_STYLE}>{counts.get(state)}</span>
        </button>
      ))}
    </div>
  )
}

// `stateLabel` and `stateColor` live in ./graph-canvas.tsx: the canvas's match
// list needs the pair as much as this panel's detail column does, and one
// definition with two readers beats two that drift.

// --- Styles ---------------------------------------------------------------

/** Inside the canvas the controls are one wrapping row, unlike the header's. */
const TOOLBAR_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 6,
}

const STATUS_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 6,
}

/**
 * One state's pill: the dot carries the colour, the INVERSION carries the
 * selection.
 *
 * The same inversion the host/browser pair uses a few lines up, and deliberately:
 * a section that shows "this one is on" two different ways makes a reader learn
 * the convention twice. It used to be a 1px border in the label colour, which at
 * this size read as an accident rather than a state.
 */
function STATUS_BUTTON_STYLE(active: boolean): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '2px 10px 2px 8px',
    border: '1px solid transparent',
    borderRadius: 999,
    background: 'var(--dsw-alias-bg-layer-2)',
    color: 'var(--dsw-alias-label-secondary)',
    font: 'inherit',
    fontSize: 12,
    cursor: 'pointer',
    ...(active
      ? {
        background: 'var(--dsw-alias-label-primary)',
        color: 'var(--dsw-alias-bg-layer-2)',
        fontWeight: 600,
      }
      : {}),
  }
}

const STATUS_DOT_STYLE: CSSProperties = {
  width: 8,
  height: 8,
  flex: 'none',
  borderRadius: 999,
}

/**
 * The count inside a pill.
 *
 * `inherit` rather than a colour of its own: the pill's foreground flips when it
 * is selected, and a tertiary grey on the inverted background is nearly unreadable
 * — the number would vanish in exactly the state the reader just clicked.
 */
const STATUS_COUNT_STYLE: CSSProperties = {
  color: 'inherit',
  opacity: 0.72,
  fontVariantNumeric: 'tabular-nums',
}

/** The scope pair: the active one inverts, so the pair reads as one control. */
function SCOPE_STYLE(active: boolean): CSSProperties {
  return {
    ...REFRESH_STYLE,
    ...(active
      ? {
        background: 'var(--dsw-alias-label-primary)',
        color: 'var(--dsw-alias-bg-layer-2)',
        borderColor: 'transparent',
      }
      : {}),
  }
}

const ROOT_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  fontSize: 13,
  color: 'var(--dsw-alias-label-primary)',
}

const HEADER_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
}

const HEADING_STYLE: CSSProperties = {
  margin: 0,
  fontSize: 16,
  fontWeight: 600,
}

const INTRO_STYLE: CSSProperties = {
  margin: 0,
  color: 'var(--dsw-alias-label-secondary)',
}

const HEADER_ACTIONS_STYLE: CSSProperties = {
  display: 'flex',
  flex: 'none',
  gap: 6,
}

const REFRESH_STYLE: CSSProperties = {
  flex: 'none',
  padding: '4px 12px',
  border: 'none',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-secondary)',
  font: 'inherit',
  fontSize: 12,
  cursor: 'pointer',
}

const MUTED_STYLE: CSSProperties = {
  margin: 0,
  padding: '16px 0',
  color: 'var(--dsw-alias-label-tertiary)',
}

const FAILED_STYLE: CSSProperties = {
  margin: 0,
  padding: '16px 0',
  color: 'var(--dsw-alias-state-error-primary)',
}

const MUTED_SMALL_STYLE: CSSProperties = {
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 12,
}

const STATS_STYLE: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
}

const CHIP_STYLE: CSSProperties = {
  padding: '2px 8px',
  borderRadius: 999,
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 12,
  fontVariantNumeric: 'tabular-nums',
}

const CHIP_WARN_STYLE: CSSProperties = {
  ...CHIP_STYLE,
  color: 'var(--dsw-alias-state-error-primary)',
}

const COLUMNS_STYLE: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 16,
  alignItems: 'flex-start',
}

/**
 * The drawing's column is the wider of the two: the layout is what the reader
 * came for, and the detail panel reads fine at its minimum width.
 */
const CANVAS_COLUMN_STYLE: CSSProperties = {
  flex: '2 1 460px',
  minWidth: 320,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
}

const COLUMN_STYLE: CSSProperties = {
  flex: '1 1 300px',
  minWidth: 260,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
}

const SUBHEADING_STYLE: CSSProperties = {
  margin: 0,
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--dsw-alias-label-secondary)',
}

const DETAIL_HEAD_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  flexWrap: 'wrap',
  gap: 8,
  marginBottom: 10,
}

const DETAIL_NAME_STYLE: CSSProperties = {
  fontWeight: 600,
}

const DETAIL_ID_STYLE: CSSProperties = {
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 12,
}

/** The package's own description: readable prose, not a label. */
const DESCRIPTION_STYLE: CSSProperties = {
  margin: '0 0 10px',
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 12,
  lineHeight: 1.5,
}

const BLOCK_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  marginTop: 10,
}

const BLOCK_TITLE_STYLE: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--dsw-alias-label-secondary)',
}

const TAGS_STYLE: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 4,
}

const TAG_STYLE: CSSProperties = {
  padding: '1px 6px',
  borderRadius: 5,
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 12,
}

const PLAIN_LIST_STYLE: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
}

const EDGE_ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 6,
  width: '100%',
  padding: '3px 6px',
  border: 'none',
  borderRadius: 5,
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  fontSize: 12,
  textAlign: 'start',
  cursor: 'pointer',
}

const PROBLEM_ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 6,
  padding: '3px 6px',
  fontSize: 12,
}

const EDGE_SERVICE_STYLE: CSSProperties = {
  flex: 'none',
  color: 'var(--dsw-alias-label-secondary)',
}

/** Badge marking an edge the plugin only takes at runtime. */
const OPTIONAL_MARK_STYLE: CSSProperties = {
  flex: 'none',
  padding: '0 6px',
  borderRadius: 5,
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 11,
}

const EDGE_ARROW_STYLE: CSSProperties = {
  flex: 'none',
  color: 'var(--dsw-alias-label-tertiary)',
}

const EDGE_NAME_STYLE: CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}
