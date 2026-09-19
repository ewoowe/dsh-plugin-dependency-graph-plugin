/**
 * The drawn dependency graph: a deterministic force layout rendered as SVG, with
 * wheel zoom, drag pan, and node selection.
 *
 * SVG and a hand-rolled layout rather than a graph library, for the same reason
 * the Node half hand-rolls its collection: this bundle's externals are a
 * whitelist (`react`/`react-dom`), so a library would be inlined regardless, and
 * a Fruchterman-Reingold pass is arithmetic that does not need to be a
 * dependency.
 *
 * The layout is DETERMINISTIC — positions are seeded from the node ids, never
 * from `Math.random` — because the graph is refetched on every open. A layout
 * that came out differently each time would make the reader re-find their
 * bearings on every visit, which is the one thing a diagram is for.
 *
 * Zoom and pan live in one `View` ({@link View}) rather than in the SVG's
 * `viewBox`: a `transform` on a group keeps stroke widths and label sizes
 * independent of the zoom, which is what the counter-scaled labels below rely on.
 */
import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode,
} from 'react'
import type { GraphEdge, GraphNode, PluginGraph } from '../graph-types.ts'
import type { Translate } from './locales.ts'

/** One node's position in layout units. */
interface Placement {
  readonly x: number
  readonly y: number
}

/** Extent of a placement set, in layout units. */
interface Bounds {
  readonly minX: number
  readonly minY: number
  readonly width: number
  readonly height: number
}

/** Pan/zoom of the drawing, where `screen = layout * scale + translate`. */
interface View {
  readonly scale: number
  readonly tx: number
  readonly ty: number
}

/**
 * Target of an eased zoom: the scale to reach and the screen point to reach it
 * about. Held instead of a finished `View` so consecutive wheel events accumulate
 * on the SCALE while each one re-anchors where the pointer actually is.
 *
 * The anchor's layout coordinates are deliberately NOT stored: every frame
 * re-derives them from the displayed view, and by construction the last frame put
 * the goal's point exactly under the goal's screen position — so the two agree,
 * and only one copy of the anchor arithmetic has to exist (`zoomAt`).
 */
interface ZoomGoal {
  /** Scale to arrive at. */
  readonly scale: number
  /** Anchor x, in container coordinates. */
  readonly screenX: number
  /** Anchor y, in container coordinates. */
  readonly screenY: number
}

/**
 * Virtual canvas the simulation runs in, and the FRAME the layout is confined
 * to: positions are clamped to it. The frame is what bounds the drawing's
 * extent, and the view then fits it to the real box.
 */
const CANVAS_WIDTH = 1440
const CANVAS_HEIGHT = 960

/**
 * Simulation steps. Sized for a composition of a few hundred nodes: enough for
 * the hubs to find each other, few enough that opening the section stays
 * interactive. The pass is O(n²·steps) — about 4M pair updates at 171 nodes.
 */
const SIMULATION_STEPS = 280

/** Golden angle, for the deterministic initial spiral. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))

/**
 * Marks a panel that scrolls itself, so the canvas's wheel handler leaves it alone.
 *
 * An attribute rather than a class: the styles here are inline objects, and the
 * handler needs to ask a question about BEHAVIOUR, not about looks — one of these
 * panes has no class at all, and a styling refactor must not be able to switch
 * the zoom back on by accident.
 */
const SCROLL_PANE_ATTR = 'data-scroll-pane'

/** Zoom clamp, and the padding kept around a fitted drawing, in screen px. */
const MIN_SCALE = 0.12
const MAX_SCALE = 5
const FIT_PADDING = 32

/**
 * Wheel sensitivity: one notch (`deltaY` ±100) is about ±14%. Applied to
 * `Math.exp`, so the factor is symmetric — zooming in and back out by the same
 * number of notches returns to where it started.
 */
const WHEEL_SENSITIVITY = 0.0015

/** Fraction of the remaining distance the eased zoom covers per frame (~170ms). */
const ZOOM_EASE = 0.22

/**
 * Difference at which the eased zoom is snapped to its target and stopped. An
 * easing curve only approaches its target, and a scale that never quite arrives
 * would leave the anchor point a hair off centre.
 */
const ZOOM_SETTLE = 0.0008

/** Below this zoom only hubs keep their labels; above it every node does. */
const LABEL_ZOOM = 0.75

/**
 * Minimum distance two nodes may end up apart, in layout units, and the cap on
 * the passes that enforce it. The frame is what bounds the drawing, but it also
 * presses nodes together where the repulsion has nowhere left to push them, so
 * the residual overlaps are resolved directly rather than traded for a weaker
 * bound: the pass is allowed to overflow the frame by at most this distance, and
 * the fit absorbs that.
 */

/** Degree at which a node counts as a hub and keeps its label when zoomed out. */
const HUB_DEGREE = 5

/**
 * The radial layout: a node sits closer to the centre the MORE plugins depend on it.
 *
 * Position is DATA, not physics. "How many plugins depend on me" is a fact about
 * the composition, and putting the load-bearing plugins at the centre makes the
 * SHAPE of the deployment readable at a glance: the hubs are the middle, the
 * leaves are the rim. A force layout cannot say that -- it only knows springs and
 * repulsion, and a node with no edges ends up wherever the repulsion leaves it,
 * which was the ring of stuck dots on the border.
 *
 * The radius eases with the SQUARE ROOT of the normalized in-degree: linear
 * would push almost every node (most have in-degree 0-2) out to the rim and leave
 * the middle empty; the root folds the mid-tier inward so the centre is a genuine
 * cluster of hubs rather than one lonely dot.
 *
 * Angle is a golden-angle walk over the id order, so nodes sharing a ring stay
 * evenly spaced and the whole arrangement is deterministic.
 * @param graph - the fetched graph.
 * @returns node id → position, in layout units.
 */
function layoutGraph(graph: PluginGraph): Map<string, Placement> {
  const maxRadius = 1100

  // In-degree: how many plugins depend on this one. Edges point FROM the
  // consumer TO the provider, so an edge's `to` is a dependency MET.
  const inDegree = new Map<string, number>(graph.nodes.map(node => [node.id, 0]))
  let maxIn = 0
  for (const edge of graph.edges) {
    const count = (inDegree.get(edge.to) ?? 0) + 1
    inDegree.set(edge.to, count)
    if (count > maxIn) maxIn = count
  }

  const placements = new Map<string, Placement>()
  // The angle walk goes over the ID order (deterministic); the radius is each
  // node's own in-degree, so the two must not be conflated.
  const ordered = [...graph.nodes].sort((left, right) => left.id.localeCompare(right.id))
  ordered.forEach((node, index) => {
    const normalized = maxIn > 0 ? (inDegree.get(node.id) ?? 0) / maxIn : 0
    const radius = maxRadius * (1 - Math.sqrt(normalized))
    const angle = index * GOLDEN_ANGLE
    placements.set(node.id, {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
    })
  })
  return placements
}


/**
 * Extent of a placement set.
 * @param placement - node id → position.
 * @returns the bounding box, with a non-zero size so a fit never divides by zero.
 */
function boundsOf(placement: Map<string, Placement>): Bounds {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const { x, y } of placement.values()) {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, width: 1, height: 1 }
  return {
    minX,
    minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  }
}

/**
 * Undirected neighbours of every node.
 *
 * Undirected on purpose: a reader hovering a hub wants to see everything wired
 * to it, and "depends on me" is as interesting as "I depend on" — which is the
 * same argument the detail panel's two edge lists make.
 * @param graph - the fetched graph.
 * @returns node id → ids it shares an edge with.
 */
function adjacencyOf(graph: PluginGraph): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>()
  const link = (from: string, to: string): void => {
    const set = adjacency.get(from) ?? new Set<string>()
    set.add(to)
    adjacency.set(from, set)
  }
  for (const edge of graph.edges) {
    link(edge.from, edge.to)
    link(edge.to, edge.from)
  }
  return adjacency
}

/** Clamp a zoom factor into the allowed range. */
function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

/**
 * Zoom about a screen point, holding the layout point under it still.
 * @param view - current pan/zoom.
 * @param screenX - anchor x, in container coordinates.
 * @param screenY - anchor y, in container coordinates.
 * @param factor - scale multiplier; above 1 zooms in.
 * @returns the new pan/zoom.
 */
function zoomAt(view: View, screenX: number, screenY: number, factor: number): View {
  const scale = clampScale(view.scale * factor)
  // The anchor is the fixed point of the transform: solve for the translate
  // that keeps `layout * scale + translate` equal at the anchor.
  const ratio = scale / view.scale
  return {
    scale,
    tx: screenX - (screenX - view.tx) * ratio,
    ty: screenY - (screenY - view.ty) * ratio,
  }
}

/**
 * Pan/zoom that fits the whole drawing inside a container.
 * @param bounds - extent of the layout.
 * @param width - container width in px.
 * @param height - container height in px.
 * @returns the fitted pan/zoom.
 */
function fitView(bounds: Bounds, width: number, height: number): View {
  const scale = clampScale(Math.min(
    (width - FIT_PADDING * 2) / bounds.width,
    (height - FIT_PADDING * 2) / bounds.height,
  ))
  return {
    scale,
    tx: (width - bounds.width * scale) / 2 - bounds.minX * scale,
    ty: (height - bounds.height * scale) / 2 - bounds.minY * scale,
  }
}

/**
 * Node colour by lifecycle state.
 *
 * Exported because the status row draws the same dots: a legend whose colours
 * were picked anywhere else would be a second opinion about the same fact.
 */
export function stateColor(state: string): string {
  if (state === 'active') return 'var(--dsw-alias-state-success-primary)'
  if (state === 'failed') return 'var(--dsw-alias-state-error-primary)'
  // Two consumers now — the detail column and the match list — so the pair lives
  // together here rather than one of them importing the panel.
  return 'var(--dsw-alias-label-secondary)'
}

/**
 * Human label for a fiber state.
 *
 * Seven states reach here: `collect.ts` mirrors Cordis's own `FiberState` and
 * adds `unloaded` for an entry with no fiber at all. It used to fold five of them
 * into one word, which threw away information the collector had already gone to
 * the trouble of reading.
 */
export function stateLabel(state: string, t: Translate): string {
  switch (state) {
    case 'active': return t('stateActive')
    case 'failed': return t('stateFailed')
    case 'pending': return t('statePending')
    case 'loading': return t('stateLoading')
    case 'unloading': return t('stateUnloading')
    case 'disposed': return t('stateDisposed')
    case 'unloaded': return t('stateUnloaded')
    default: return t('stateOther')
  }
  return 'var(--dsw-alias-label-tertiary)'
}

/**
 * Node radius. Providers and the well-connected read as hubs before any label
 * does, which is what makes the shape of the composition legible when zoomed out.
 * @param node - the node.
 * @param degree - number of edges it is an end of.
 * @returns the radius, in layout units.
 */
/**
 * Node radius: a node more plugins depend on reads as a bigger dot -- the same
 * signal the radial layout encodes in distance, echoed in size.
 * @param inDegree - how many plugins depend on this node.
 * @returns the radius, in layout units.
 */
function radiusOf(inDegree: number): number {
  return 3 + Math.min(13, inDegree * 0.5)
}

/** One laid-out node, with the values that do not depend on the view. */
interface Mark {
  readonly node: GraphNode
  readonly placement: Placement
  readonly radius: number
  readonly degree: number
}

interface EdgeMarkProps {
  readonly edge: GraphEdge
  readonly from: Placement
  readonly to: Placement
  /** True when a highlight is active and this edge is not part of it. */
  readonly dim: boolean
  /**
   * Which way this edge runs relative to the highlighted node.
   *
   * `out` is what the selected plugin depends on, `in` is what depends on it,
   * `none` is every edge while nothing is selected. The two directions are the
   * two halves of the answer the graph exists to give, and one colour for both
   * made the reader trace each line to its end to tell them apart.
   */
  readonly role: EdgeRole
}

/** An edge's direction, as seen from the selected node. */
type EdgeRole = 'out' | 'in' | 'none'

/**
 * Stroke by direction: brand (blue) for what this plugin needs, warn (orange)
 * for what needs it.
 *
 * Blue and orange rather than blue and green: the first pair were both cool and
 * too close on a 1.8px line — a reader had to follow the wire to its end to tell
 * the directions apart, which is exactly what the colours were added to save.
 * Opposite sides of the wheel also survive the common colour-vision deficiencies,
 * where a blue/green pair does not. `success` is still used, for NODE state —
 * that is a different question and a different surface.
 *
 * The `optional` dash is independent and survives: a dashed blue line is a
 * runtime dependency of mine, a dashed orange one is somebody who finds me at
 * runtime.
 */
function edgeStroke(role: EdgeRole): string {
  // NOT `brand-primary`: the name sounds like a brand blue and the value is
  // `neutral-bluish-1000` — a blue-tinted GREY, which is why the outgoing wires
  // read as grey on screen. `state-business-primary` is the DeepSeek blue
  // (`rgb(65, 118, 230)` over `deepseek-400` in dark), and being an alias it
  // adapts to the theme, which the raw `--dsw-static-*` palette would not.
  if (role === 'out') return 'var(--dsw-alias-state-business-primary)'
  if (role === 'in') return 'var(--dsw-alias-state-warn-primary)'
  return 'var(--dsw-alias-label-secondary)'
}

function EdgeMark({ edge, from, to, dim, role }: EdgeMarkProps): ReactNode {
  const lit = role !== 'none'
  return (
    <line
      x1={from.x}
      y1={from.y}
      x2={to.x}
      y2={to.y}
      // Keeps the stroke one screen pixel wide at every zoom: this is a wire,
      // not a scaled drawing.
      vectorEffect="non-scaling-stroke"
      style={{
        stroke: lit ? edgeStroke(role) : 'var(--dsw-alias-border-l2)',
        strokeWidth: lit ? 1.8 : 1,
        // Dashed for a runtime acquisition, matching the `optional` badge in
        // the detail panel — the same distinction, drawn instead of spelled.
        strokeDasharray: edge.optional ? '3 3' : undefined,
        // Full strength when it carries a direction: at 0.7 over a busy graph the
        // two hues looked closer to each other than they are, which was half of
        // the "too similar" report. Unrelated wires stay light so the answer
        // still stands out from the context.
        opacity: dim ? 0.1 : lit ? 0.95 : 0.6,
      }}
    />
  )
}

interface NodeMarkProps {
  readonly mark: Mark
  readonly scale: number
  readonly focused: boolean
  readonly dim: boolean
  readonly label: boolean
  readonly onSelect: (id: string) => void
  readonly onHover: (id: string) => void
}

function NodeMark({ mark, scale, focused, dim, label, onSelect, onHover }: NodeMarkProps): ReactNode {
  const { node, placement, radius } = mark
  return (
    <g
      transform={`translate(${String(placement.x)},${String(placement.y)})`}
      style={dim ? DIM_STYLE : undefined}
      onPointerEnter={() => { onHover(node.id) }}
      onClick={() => { onSelect(node.id) }}
    >
      <circle
        r={radius}
        style={{
          fill: focused ? 'var(--dsw-alias-label-primary)' : stateColor(node.state),
          stroke: 'var(--dsw-alias-bg-layer-1)',
          strokeWidth: 1.5,
          cursor: 'pointer',
        }}
      />
      {label && (
        // Counter-scaled, so a label stays legible instead of shrinking into a
        // smudge when the whole composition is in view. The offset has to be
        // expressed in the counter-scaled frame, hence `radius * scale`.
        <g transform={`scale(${String(1 / scale)})`}>
          <text y={radius * scale + 4} textAnchor="middle" style={LABEL_STYLE}>
            {node.name}
          </text>
        </g>
      )}
    </g>
  )
}

/** Props the hosts hand the canvas. */
export interface GraphCanvasProps {
  /** The fetched graph. */
  readonly graph: PluginGraph
  /** Currently selected node id, or null. */
  readonly selected: string | null
  /** Select a node, or `null` to deselect (a plain click on the empty canvas). */
  readonly onSelect: (id: string | null) => void
  /** Locale-bound translate. */
  readonly t: Translate
  /**
   * Height of the drawing area, in px. A prop because the two hosts sit in very
   * different boxes: a settings column wants a fixed panel, a whole page wants
   * to use the window.
   */
  readonly height?: number
  /**
   * The selection's detail, drawn INSIDE the canvas while it is fullscreen.
   *
   * The fullscreen element is the canvas, so the panel's own detail column is not
   * on screen at all in that mode: clicking a node would then look like it did
   * nothing but highlight. The host passes the SAME element it renders in its own
   * column, so there is one Detail component, not two that drift.
   */
  readonly detail?: ReactNode
  /**
   * Show only nodes whose lifecycle state is exactly this, or null/undefined for
   * all of them.
   *
   * A state and not a category: the status row in the panel offers whatever
   * states the graph actually has, so "not loaded" means `unloaded` and nothing
   * else — `pending` and `loading` are their own entries with their own counts.
   * Dimmed rather than removed, exactly like a search: dropping nodes would move
   * every other one, and position is the thing this layout is saying.
   */
  readonly filter?: string | null
  /**
   * The panel's own controls — the tree switch, refresh, and the status row —
   * drawn INSIDE the canvas while it is fullscreen.
   *
   * The fullscreen element is the canvas, so everything the panel put beside the
   * drawing is off screen in that mode: the buttons a reader needs most while
   * looking closely at the graph are exactly the ones that disappear. The host
   * passes the same elements it renders above the drawing, so there is one set of
   * controls, not two that drift. Outside fullscreen the canvas does not draw
   * this at all — the panel's own copy is already on screen.
   */
  readonly toolbar?: ReactNode
  /**
   * Selection history, for the two navigation buttons.
   *
   * Passed in rather than kept here: the selection lives in the panel, which
   * owns the detail column beside the drawing — the canvas renders the buttons,
   * it does not own the state they move through.
   */
  readonly history?: {
    readonly canBack: boolean
    readonly canForward: boolean
    readonly onBack: () => void
    readonly onForward: () => void
  }
}

/**
 * The canvas: layout, view state, and the two interaction paths.
 * @param props - see {@link GraphCanvasProps}.
 * @returns the drawing, its search box, its zoom controls, and its hint line.
 */
export function GraphCanvas({
  graph, selected, onSelect, t, height = 520, detail, filter = null, toolbar, history,
}: GraphCanvasProps): ReactNode {
  // The simulation is memoised on the graph object, so it runs once per fetch
  // rather than once per render.
  const placement = useMemo(() => layoutGraph(graph), [graph])
  const bounds = useMemo(() => boundsOf(placement), [placement])
  const adjacency = useMemo(() => adjacencyOf(graph), [graph])
  const inDegree = useMemo(() => {
    const map = new Map<string, number>(graph.nodes.map(node => [node.id, 0]))
    for (const edge of graph.edges) {
      map.set(edge.to, (map.get(edge.to) ?? 0) + 1)
    }
    return map
  }, [graph])
  const marks = useMemo<Mark[]>(() => graph.nodes.map(node => ({
    node,
    placement: placement.get(node.id) ?? { x: 0, y: 0 },
    radius: radiusOf(inDegree.get(node.id) ?? 0),
    degree: adjacency.get(node.id)?.size ?? 0,
  })), [graph, placement, adjacency, inDegree])

  const [hovered, setHovered] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  // Only so the clear button can hand the caret back: clearing is a retype
  // gesture, not a dismissal.
  const inputRef = useRef<HTMLInputElement>(null)
  const [box, setBox] = useState<{ readonly width: number; readonly height: number } | null>(null)

  // The displayed view lives in a ref as well as in state. The easing loop below
  // runs on `requestAnimationFrame`, where a value captured by the render that
  // started it is stale by the second frame; state is only the render trigger.
  const viewRef = useRef<View>({ scale: 1, tx: 0, ty: 0 })
  const [view, setView] = useState<View>(viewRef.current)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const panFrom = useRef<{ readonly x: number; readonly y: number } | null>(null)
  /** True once this press has moved the view -- a real drag, not a stray click. */
  const movedRef = useRef(false)
  /** Zoom in flight, or null when the view is settled. */
  const goal = useRef<ZoomGoal | null>(null)
  const frame = useRef<number | null>(null)

  /** Write the view to the ref and to the renderer. */
  const publish = useCallback((next: View): void => {
    viewRef.current = next
    setView(next)
  }, [])

  /** Cancel an eased zoom in flight, leaving the view where it is. */
  const stopZoom = useCallback((): void => {
    goal.current = null
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current)
      frame.current = null
    }
  }, [])

  /**
   * Begin, or re-aim, an eased zoom toward `factor × current scale`, about the
   * given screen point.
   *
   * The scale accumulates across events while the anchor is re-read from the
   * DISPLAYED view each time. That is what makes a fast wheel spin add up instead
   * of being swallowed frame by frame, without the anchor drifting when the
   * pointer moves between events.
   */
  const startZoom = useCallback((factor: number, screenX: number, screenY: number): void => {
    goal.current = {
      scale: clampScale((goal.current?.scale ?? viewRef.current.scale) * factor),
      screenX,
      screenY,
    }
    if (frame.current !== null) return
    const tick = (): void => {
      const target = goal.current
      if (target === null) { frame.current = null; return }
      const shown = viewRef.current
      const eased = clampScale(shown.scale + (target.scale - shown.scale) * ZOOM_EASE)
      const settled = Math.abs(target.scale - eased) < ZOOM_SETTLE
      // `zoomAt` rather than the transform written out again: it scales about an
      // anchor, and the point under that anchor is the one the previous frame put
      // there — which is the point this zoom exists to hold still.
      const scale = settled ? target.scale : eased
      publish(zoomAt(shown, target.screenX, target.screenY, scale / shown.scale))
      if (settled) { goal.current = null; frame.current = null; return }
      frame.current = requestAnimationFrame(tick)
    }
    frame.current = requestAnimationFrame(tick)
  }, [publish])

  // A zoom in flight holds a pending frame; abandoning it would let it keep
  // writing the view of an unmounted canvas.
  useEffect(() => () => { stopZoom() }, [stopZoom])

  // The container's size is unknown until layout, and the settings column can be
  // resized while open, so the fit and the zoom buttons both read it from here.
  //
  // A layout effect, as is the fit below: measuring after paint would put one
  // frame of unfitted, wrongly-scaled drawing on screen and then jump.
  useLayoutEffect(() => {
    const host = hostRef.current
    if (host === null) return undefined
    const measure = (): void => { setBox({ width: host.clientWidth, height: host.clientHeight }) }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    return () => { observer.disconnect() }
  }, [])

  // Fit on a new graph and on a new box. A reader who resized the panel wants
  // the drawing back in view, and a fit is cheap.
  useLayoutEffect(() => {
    if (box === null || box.width === 0 || box.height === 0) return
    stopZoom()
    publish(fitView(bounds, box.width, box.height))
  }, [bounds, box, publish, stopZoom])

  // A non-passive listener, not React's `onWheel`: React attaches `wheel` at the
  // root as passive, so `preventDefault` there cannot stop the settings page from
  // scrolling behind the canvas.
  useEffect(() => {
    const host = hostRef.current
    if (host === null) return undefined
    const onWheel = (event: WheelEvent): void => {
      // A wheel inside a scroll pane belongs to that pane. The match list and the
      // detail card are PANELS OVER the drawing: a reader scrolling a list of
      // results means to scroll the list, not to zoom the graph behind it.
      //
      // Judged HERE rather than by stopping propagation inside the pane, because
      // this listener is native and sits on an ancestor: it runs before React's
      // delegated handlers, so a `stopPropagation` in the pane would arrive after
      // the zoom had already happened. Returning without `preventDefault` is also
      // what lets the pane scroll at all — the default action is the feature here,
      // not the thing to stop.
      if (event.target instanceof Element && event.target.closest(`[${SCROLL_PANE_ATTR}]`) !== null) return
      event.preventDefault()
      const rect = host.getBoundingClientRect()
      startZoom(
        Math.exp(-event.deltaY * WHEEL_SENSITIVITY),
        event.clientX - rect.left,
        event.clientY - rect.top,
      )
    }
    host.addEventListener('wheel', onWheel, { passive: false })
    return () => { host.removeEventListener('wheel', onWheel) }
  }, [startZoom])

  const panStart = useCallback((event: ReactPointerEvent<SVGRectElement>): void => {
    if (event.button !== 0) return
    // A pan and an eased zoom both write the view, and the pan is the newer
    // intent — without this the animation would keep overwriting the drag.
    stopZoom()
    movedRef.current = false
    panFrom.current = { x: event.clientX, y: event.clientY }
    event.currentTarget.setPointerCapture(event.pointerId)
  }, [stopZoom])

  const panMove = useCallback((event: ReactPointerEvent<SVGRectElement>): void => {
    const from = panFrom.current
    if (from === null) return
    const dx = event.clientX - from.x
    const dy = event.clientY - from.y
    panFrom.current = { x: event.clientX, y: event.clientY }
    // Any single move over 2px marks this press as a real drag, so its release
    // will not be mistaken for the click that deselects.
    if (Math.hypot(dx, dy) > 2) movedRef.current = true
    const current = viewRef.current
    publish({ ...current, tx: current.tx + dx, ty: current.ty + dy })
  }, [publish])

  const panEnd = useCallback((event: ReactPointerEvent<SVGRectElement>): void => {
    panFrom.current = null
    // A press that never moved is a DESELECT: without it, a selection can only
    // ever be replaced by another one, and the reader has no way back. A press
    // that DID move was a pan -- the reader's intent was to move the view, and
    // deselecting on its release would make every pan steal the selection.
    if (!movedRef.current) onSelect(null)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }, [onSelect])

  const zoomBy = useCallback((factor: number): void => {
    if (box === null) return
    startZoom(factor, box.width / 2, box.height / 2)
  }, [box, startZoom])

  const fit = useCallback((): void => {
    if (box === null) return
    stopZoom()
    publish(fitView(bounds, box.width, box.height))
  }, [bounds, box, publish, stopZoom])

  // Fullscreen for the DRAWING itself: the canvas element becomes the fullscreen
  // element, so the reader gets the biggest possible view of the graph. The
  // panel's chrome is left behind on purpose -- a fullscreen view is for looking
  // at the picture, and Esc or the same button comes back.
  const [isFullscreen, setIsFullscreen] = useState(false)
  useEffect(() => {
    const onChange = (): void => { setIsFullscreen(document.fullscreenElement === hostRef.current) }
    document.addEventListener('fullscreenchange', onChange)
    return () => { document.removeEventListener('fullscreenchange', onChange) }
  }, [])
  const toggleFullscreen = useCallback((): void => {
    if (document.fullscreenElement === hostRef.current) {
      void document.exitFullscreen()
      return
    }
    void hostRef.current?.requestFullscreen()
  }, [])

  // Search matches, or null when the box is empty. Null and "empty set" are
  // different states: the first dims nothing at all, the second dims everything
  // and reads as "no match", which is what an unmatched query has to look like.
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle === '') return null
    const found = new Set<string>()
    for (const node of graph.nodes) {
      if (node.name.toLowerCase().includes(needle) || node.id.toLowerCase().includes(needle)) {
        found.add(node.id)
      }
    }
    return found
  }, [graph, query])

  // The matches as a LIST, not just as the set the dimming reads: a reader who
  // typed a name wants to see what it found, in text, with each one's state
  // beside it — the drawing already says which dots are lit, but not what they
  // are called or whether they loaded. Sorted by name so the order is stable
  // between keystrokes and does not reshuffle under the pointer.
  const matched = useMemo(() => {
    if (matches === null) return null
    return graph.nodes
      .filter(node => matches.has(node.id))
      .sort((left, right) => left.name.localeCompare(right.name))
  }, [graph, matches])

  // The status filter's own set, or null when no status is chosen. Separate from
  // the search above because they answer different questions, and kept as a set
  // so the two can be folded into one rule below.
  const statusMatches = useMemo(() => {
    if (filter === null) return null
    const found = new Set<string>()
    for (const node of graph.nodes) {
      if (node.state === filter) found.add(node.id)
    }
    return found
  }, [graph, filter])

  // The one set dimming reads. Two independent reasons to hide a node — the
  // search and the status filter — compose by INTERSECTION: a node is shown when
  // it satisfies both, and `null` on either side means that side is not on. A
  // node that the filter excludes is dimmed even when the search matched it,
  // which is the only reading that makes the two usable together.
  const shown = useMemo(() => {
    if (matches === null) return statusMatches
    if (statusMatches === null) return matches
    return new Set([...matches].filter(id => statusMatches.has(id)))
  }, [matches, statusMatches])

  // The highlight follows the pointer first, the selection second: hovering is
  // the exploratory gesture, and it should not require a click to undo. The
  // search and the status filter are further, independent dimming reasons — they
  // apply whether or not anything is hovered, so all of them compose instead of
  // one masking another.
  const focus = hovered ?? selected
  const related = focus === null ? null : adjacency.get(focus) ?? null
  const labelled = view.scale >= LABEL_ZOOM
  const nodeDim = (id: string): boolean =>
    (shown !== null && !shown.has(id))
    || (related !== null && id !== focus && !related.has(id))
  const nodeLabel = (mark: Mark): boolean =>
    (shown !== null && shown.has(mark.node.id))
    || labelled
    || mark.degree >= HUB_DEGREE
    || mark.node.id === focus
    || related?.has(mark.node.id) === true
  const edgeDim = (edge: GraphEdge): boolean => {
    // An edge survives a search only when BOTH ends match: one matched endpoint
    // and one unmatched is precisely the context the search is trying to hide.
    // The status filter reads the same way, for the same reason.
    if (shown !== null && !(shown.has(edge.from) && shown.has(edge.to))) return true
    if (focus === null) return false
    return edge.from !== focus && edge.to !== focus
  }

  return (
    <div
      ref={hostRef}
      style={{ ...HOST_STYLE, height: isFullscreen ? '100vh' : height }}
      onPointerLeave={() => { setHovered(null) }}
    >
      <svg style={SVG_STYLE}>
        {/* The backdrop owns pan and the hover reset. It sits before the drawing
            so nodes paint over it and take their own pointer events first. */}
        <rect
          x={0}
          y={0}
          width="100%"
          height="100%"
          style={BACKDROP_STYLE}
          onPointerDown={panStart}
          onPointerMove={panMove}
          onPointerUp={panEnd}
          onPointerCancel={panEnd}
          onPointerEnter={() => { setHovered(null) }}
        />
        <g transform={`translate(${String(view.tx)},${String(view.ty)}) scale(${String(view.scale)})`}>
          {graph.edges.map((edge) => {
            const from = placement.get(edge.from)
            const to = placement.get(edge.to)
            if (from === undefined || to === undefined) return null
            return (
              <EdgeMark
                key={`${edge.from}|${edge.to}|${edge.service}`}
                edge={edge}
                from={from}
                to={to}
                role={focus === null
                  ? 'none'
                  : edge.from === focus ? 'out' : edge.to === focus ? 'in' : 'none'}
                dim={edgeDim(edge)}
              />
            )
          })}
          {marks.map(mark => (
            <NodeMark
              key={mark.node.id}
              mark={mark}
              scale={view.scale}
              focused={mark.node.id === focus}
              dim={nodeDim(mark.node.id)}
              label={nodeLabel(mark)}
              onSelect={onSelect}
              onHover={setHovered}
            />
          ))}
        </g>
      </svg>
      <div style={CONTROLS_STYLE}>
        {/* First in the row, because they are the only controls here that move
            the SELECTION rather than the view. Disabled rather than hidden: a
            button that vanishes when it has nothing to do shuffles the ones
            beside it under a pointer that was already on its way. */}
        {history !== undefined && (
          <>
            <button
              type="button"
              style={controlStyle(history.canBack)}
              title={t('historyBack')}
              disabled={!history.canBack}
              onClick={history.onBack}
            >
              ←
            </button>
            <button
              type="button"
              style={controlStyle(history.canForward)}
              title={t('historyForward')}
              disabled={!history.canForward}
              onClick={history.onForward}
            >
              →
            </button>
          </>
        )}
        <button type="button" style={CONTROL_STYLE} title={t('zoomIn')} onClick={() => { zoomBy(1.3) }}>+</button>
        <button type="button" style={CONTROL_STYLE} title={t('zoomOut')} onClick={() => { zoomBy(1 / 1.3) }}>−</button>
        <button type="button" style={CONTROL_STYLE} title={t('fitView')} onClick={fit}>{t('fitView')}</button>
        <button
          type="button"
          style={CONTROL_STYLE}
          title={isFullscreen ? t('exitFullscreen') : t('fullscreen')}
          onClick={toggleFullscreen}
        >
          {isFullscreen ? t('exitFullscreen') : t('fullscreen')}
        </button>
      </div>
      {/* Always on, as a KEY rather than a status report.
          It was conditioned on a selection at first, the intent being to avoid a
          legend for colours that are not currently on screen — but the reader who
          has not clicked yet is exactly the one who needs to know what the
          colours mean, and a legend that only appears after selecting explains
          the drawing to someone who has already read it. So the swatches keep the
          SELECTED colours whether or not anything is selected.
          The words are the detail panel's own two list titles, so the drawing and
          the column name the two directions the same way. */}
      <div style={LEGEND_STYLE}>
        <span style={LEGEND_ITEM_STYLE}>
          <span style={{ ...LEGEND_LINE_STYLE, background: 'var(--dsw-alias-state-business-primary)' }} />
          {t('dependsOn')}
        </span>
        <span style={LEGEND_ITEM_STYLE}>
          <span style={{ ...LEGEND_DASHED_STYLE, borderTopColor: 'var(--dsw-alias-state-business-primary)' }} />
          {t('optionalOut')}
        </span>
        <span style={LEGEND_ITEM_STYLE}>
          <span style={{ ...LEGEND_LINE_STYLE, background: 'var(--dsw-alias-state-warn-primary)' }} />
          {t('usedBy')}
        </span>
        <span style={LEGEND_ITEM_STYLE}>
          <span style={{ ...LEGEND_DASHED_STYLE, borderTopColor: 'var(--dsw-alias-state-warn-primary)' }} />
          {t('optionalIn')}
        </span>
      </div>
      <div style={HINT_STYLE}>{t('graphHint')}</div>
      {/* The canvas's top-left corner, one column so the two things that want it
          stack rather than cover each other: the match list whenever there is a
          query, and the host's controls while fullscreen. */}
      <div style={TOPLEFT_STYLE}>
        {/* Fullscreen only, and FIRST: outside fullscreen the host renders the
            same controls above the drawing, and inside it the reader needs them
            more than anything else on the page — so they take the top line and
            everything below them shifts down. */}
        {isFullscreen && toolbar !== undefined && (
          <div style={FULLSCREEN_TOOLBAR_STYLE}>{toolbar}</div>
        )}
        <div style={SEARCH_STYLE}>
          <div style={SEARCH_FIELD_STYLE}>
            <input
              ref={inputRef}
              // `text` with a searchbox role, not `type="search"`: WebKit draws a
              // cancel button of its own inside a search field, and it cannot be
              // suppressed from here — the pseudo-element takes CSS, not a `style`
              // attribute, and this file styles everything inline. Two clear buttons
              // would be one too many, and the browser's is the one that cannot be
              // made to match. The role keeps the semantics the type was carrying.
              type="text"
              role="searchbox"
              value={query}
              placeholder={t('searchPlaceholder')}
              aria-label={t('searchPlaceholder')}
              onChange={(event) => { setQuery(event.target.value) }}
              style={SEARCH_INPUT_STYLE}
            />
            {/* Only while there is something to clear, and the field is focused
                afterwards: the gesture is "that is not what I meant, let me retype",
                so the caret goes back where it was rather than the box going dead. */}
            {query !== '' && (
              <button
                type="button"
                aria-label={t('searchClear')}
                title={t('searchClear')}
                onClick={() => {
                  setQuery('')
                  inputRef.current?.focus()
                }}
                style={SEARCH_CLEAR_STYLE}
              >
                ×
              </button>
            )}
          </div>
          {/* Only for a non-empty query: a match count next to an empty box would
              be a number about nothing. */}
          {matches !== null && (
            <span style={matches.size === 0 ? SEARCH_NONE_STYLE : SEARCH_COUNT_STYLE}>
              {matches.size === 0 ? t('searchNone') : t('searchMatches', { value: matches.size })}
            </span>
          )}
        </div>
        {matched !== null && matched.length > 0 && (
          <div style={MATCH_LIST_STYLE} {...{ [SCROLL_PANE_ATTR]: '' }}>
            {matched.map(node => (
              <button
                key={node.id}
                type="button"
                // Selecting from the list is the same act as clicking the node —
                // and it works for one that is dimmed off to the side, which is
                // half the reason to search for it by name.
                onClick={() => { onSelect(node.id) }}
                style={MATCH_ROW_STYLE}
              >
                <span style={{ ...MATCH_DOT_STYLE, background: stateColor(node.state) }} />
                <span style={MATCH_NAME_STYLE}>{node.name}</span>
                <span style={MATCH_STATE_STYLE}>{stateLabel(node.state, t)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {/* Fullscreen only: outside it the host renders this in its own column. */}
      {isFullscreen && detail !== undefined && (
        <div style={FULLSCREEN_DETAIL_STYLE} {...{ [SCROLL_PANE_ATTR]: '' }}>{detail}</div>
      )}
    </div>
  )
}

/**
 * The canvas's top-left corner, below the search box.
 *
 * `top: 52` matches the detail card on the other side exactly, so the two read as
 * one frame: a card left, a card right, both starting on the same line. The
 * search box above it ends at 36, and the zoom controls beside it start at 8 —
 * the second row is the first place nothing is already sitting.
 *
 * `maxWidth` leaves the detail card's own column (`right: 12`, `width: 320`)
 * clear so the two never overlap. One column for both occupants — the match list
 * and the fullscreen controls — because they want the same corner and would
 * otherwise cover each other; stacked, each one's height is simply the other's
 * offset.
 */
const TOPLEFT_STYLE: CSSProperties = {
  position: 'absolute',
  top: 8,
  left: 8,
  // Leaves the zoom controls (`top: 8, right: 8`) their own corner: this column
  // now starts on the same line as them, so it must stop before reaching across.
  maxWidth: 'calc(100% - 200px)',
  maxHeight: 'calc(100% - 96px)',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: 8,
}

/**
 * The search matches, as a scannable list.
 *
 * The same card as the detail panel — the width, the radius, the padding and the
 * shadow are copied from {@link FULLSCREEN_DETAIL_STYLE} on purpose: one floats on
 * the left and one on the right, and two cards holding the same place in the
 * frame should not look like they came from different designs. A FIXED `width`
 * rather than a maximum, for the same reason: a list that shrank to its longest
 * name would move its own edge on every keystroke.
 *
 * Scrolls on its own rather than growing: a query like `dsh-client` matches half
 * the composition, and a list that tall would bury the drawing it is meant to
 * help read.
 */
const MATCH_LIST_STYLE: CSSProperties = {
  width: 320,
  boxSizing: 'border-box',
  maxHeight: '100%',
  overflowY: 'auto',
  padding: 10,
  borderRadius: 12,
  border: '0.5px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-1)',
  boxShadow: '0 8px 28px rgba(0, 0, 0, 0.28)',
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
}

const MATCH_ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  width: '100%',
  padding: '3px 6px',
  border: 'none',
  borderRadius: 6,
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  fontSize: 12,
  textAlign: 'start',
  cursor: 'pointer',
}

const MATCH_DOT_STYLE: CSSProperties = {
  width: 7,
  height: 7,
  flex: 'none',
  borderRadius: 999,
}

const MATCH_NAME_STYLE: CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const MATCH_STATE_STYLE: CSSProperties = {
  flex: 'none',
  marginLeft: 'auto',
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 11,
}

/**
 * The panel's controls, as a bar over a fullscreen canvas.
 *
 * Positioned by {@link TOPLEFT_STYLE}, the column it shares with the match list:
 * no `right`, no `pointerEvents: none`, so the bar is as wide as its contents and
 * the drawing stays draggable everywhere the buttons are not.
 */
const FULLSCREEN_TOOLBAR_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 8,
}

/**
 * The selection's detail, as a floating card over a fullscreen canvas.
 *
 * A card rather than a docked column: with margins of its own the graph stays
 * visible around it, and its height follows the content instead of pretending to
 * be full height. `top: 52` clears the zoom/fullscreen controls in the corner,
 * which the card would otherwise cover.
 */
const FULLSCREEN_DETAIL_STYLE: CSSProperties = {
  position: 'absolute',
  top: 52,
  right: 12,
  width: 320,
  maxHeight: 'calc(100% - 64px)',
  overflowY: 'auto',
  padding: 14,
  boxSizing: 'border-box',
  borderRadius: 12,
  border: '0.5px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-1)',
  boxShadow: '0 8px 28px rgba(0, 0, 0, 0.28)',
}

// --- Styles ---------------------------------------------------------------

const HOST_STYLE: CSSProperties = {
  position: 'relative',
  borderRadius: 12,
  background: 'var(--dsw-alias-bg-layer-1)',
  border: '0.5px solid var(--dsw-alias-border-l2)',
  overflow: 'hidden',
  // A drag on the canvas is a pan, not a text selection or a page scroll.
  touchAction: 'none',
  userSelect: 'none',
}

const SVG_STYLE: CSSProperties = {
  display: 'block',
  width: '100%',
  height: '100%',
}

const BACKDROP_STYLE: CSSProperties = {
  fill: 'transparent',
  cursor: 'grab',
}

const DIM_STYLE: CSSProperties = {
  opacity: 0.15,
}

const LABEL_STYLE: CSSProperties = {
  fill: 'var(--dsw-alias-label-secondary)',
  fontSize: 10,
  userSelect: 'none',
}

const CONTROLS_STYLE: CSSProperties = {
  position: 'absolute',
  top: 8,
  right: 8,
  display: 'flex',
  gap: 4,
}

/** A control with nothing to do yet: dimmed, and the pointer says so too. */
function controlStyle(enabled: boolean): CSSProperties {
  return enabled ? CONTROL_STYLE : { ...CONTROL_STYLE, opacity: 0.4, cursor: 'default' }
}

const CONTROL_STYLE: CSSProperties = {
  minWidth: 28,
  height: 28,
  padding: '0 8px',
  border: '0.5px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-secondary)',
  font: 'inherit',
  fontSize: 12,
  cursor: 'pointer',
}

/**
 * The search row: a plain flex line, positioned by {@link TOPLEFT_STYLE}.
 *
 * It used to be pinned to `top: 8, left: 8` on its own. It sits in the top-left
 * column instead, because fullscreen puts the controls ABOVE it — one column,
 * one order, and the row that has to move is the one already inside it.
 */
const SEARCH_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
}

/**
 * The search field: the input and its clear button, nothing else.
 *
 * A wrapper of its own so the button can be positioned against the FIELD rather
 * than against the row — the row also holds the match count, and an absolutely
 * positioned button in it would sit at the far end of the count instead of inside
 * the box.
 */
const SEARCH_FIELD_STYLE: CSSProperties = {
  position: 'relative',
  display: 'inline-flex',
  alignItems: 'center',
}

/** The clear button: INSIDE the field's right edge, where the browser's own would be. */
const SEARCH_CLEAR_STYLE: CSSProperties = {
  position: 'absolute',
  right: 4,
  top: '50%',
  transform: 'translateY(-50%)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 20,
  height: 20,
  padding: 0,
  border: 'none',
  borderRadius: 999,
  background: 'transparent',
  color: 'var(--dsw-alias-label-tertiary)',
  font: 'inherit',
  fontSize: 14,
  lineHeight: 1,
  cursor: 'pointer',
}

const SEARCH_INPUT_STYLE: CSSProperties = {
  width: 150,
  height: 28,
  // Room on the right for the clear button, reserved whether or not it is showing:
  // a padding that appeared with the text would make the field's contents shift
  // the moment the first character is typed.
  padding: '0 26px 0 8px',
  border: '0.5px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-primary)',
  font: 'inherit',
  fontSize: 12,
  outline: 'none',
  // The canvas turns selection off so a drag can pan; the box has to turn it
  // back on or a query could not be selected or corrected.
  userSelect: 'text',
}

const SEARCH_COUNT_STYLE: CSSProperties = {
  padding: '0 6px',
  borderRadius: 5,
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 11,
  fontVariantNumeric: 'tabular-nums',
}

/** A query that matched nothing is worth noticing, so it is not muted. */
const SEARCH_NONE_STYLE: CSSProperties = {
  ...SEARCH_COUNT_STYLE,
  color: 'var(--dsw-alias-state-error-primary)',
}

/**
 * The direction legend, above the hint line.
 *
 * Bottom-left rather than tucked in a corner: it explains wires that run all
 * over the drawing, and it is read after the reader has already looked at the
 * shape. Always rendered — it is a key, so it states what the colours mean
 * whether or not any are on screen right now.
 */
const LEGEND_STYLE: CSSProperties = {
  position: 'absolute',
  left: 10,
  bottom: 26,
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 12,
  fontSize: 11,
  color: 'var(--dsw-alias-label-secondary)',
}

const LEGEND_ITEM_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
}

/** A short line, like the thing it explains. */
const LEGEND_LINE_STYLE: CSSProperties = {
  width: 16,
  height: 2,
  borderRadius: 1,
}

/**
 * The dashed half of the legend: an `optional` edge, drawn as a border rather
 * than a background because a dashed border is the one thing CSS will render as
 * a dotted run at this size without an SVG or a gradient.
 */
const LEGEND_DASHED_STYLE: CSSProperties = {
  width: 16,
  height: 0,
  borderTopWidth: 2,
  borderTopStyle: 'dashed',
  borderTopColor: 'transparent',
}

const HINT_STYLE: CSSProperties = {
  position: 'absolute',
  left: 10,
  bottom: 8,
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 11,
  pointerEvents: 'none',
}
