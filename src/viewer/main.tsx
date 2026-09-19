/**
 * The standalone viewer: the dependency graph as a whole page.
 *
 * It renders the SAME panel as the settings section (../client/GraphPanel.tsx),
 * not a copy of it. The two hosts differ only in what they can supply:
 *
 * - the locale: the app binds `t` through `ctx.locale`, which does not exist on a
 *   page with no cordis runtime. The app therefore puts the locale it is IN into
 *   the URL it opens this page with, and `t` is built from the same dictionaries
 *   in ../client/locales.ts — all seven, not only the two the shell ships. The
 *   browser's own preferences are the fallback for a page opened directly;
 * - the theme: the panel styles itself with the app's `--dsw-*` design tokens,
 *   which here come from the shim in the served document (../viewer-page.ts)
 *   instead of from the app's theme;
 * - the height: a whole page uses the window rather than a fixed 520px panel.
 *
 * React is BUNDLED into this script by build.mjs rather than left external: there
 * is no module table on this page to answer a bare `react` import.
 */
import {
  createElement, useCallback, useEffect, useMemo, useState, type ReactNode,
} from 'react'
import { createRoot } from 'react-dom/client'
import { CLIENT_GRAPH_PATH, type ClientGraphReport, type PluginGraph } from '../graph-types.ts'
import { GraphPanel } from '../client/GraphPanel.tsx'
import { DICTIONARIES, en, langOf, SUPPORTED_LOCALES, type Translate } from '../client/locales.ts'

/**
 * Height kept for the panel's own chrome above and around the drawing — the
 * heading, the stats row, the problems block, the page padding. Approximate on
 * purpose: a window that still overflows simply scrolls.
 */
const CHROME_HEIGHT = 220

/**
 * Substitute `{name}` placeholders.
 *
 * The app's `t` comes from the locale service, which does this itself; a page
 * with no locale service has to repeat it. All placeholders in the dictionaries
 * are the same `{name}` form, which is what keeps this from needing to be a
 * template engine.
 * @param template - a dictionary entry, possibly containing `{name}`.
 * @param params - values by name.
 * @returns the entry with every known placeholder replaced.
 */
function interpolate(template: string, params?: Record<string, unknown>): string {
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/gu, (match, name: string) =>
    (Object.hasOwn(params, name) ? String(params[name]) : match))
}

/**
 * The locale this page should render in.
 *
 * The app's own choice wins whenever it said one: that is what the `?lang=`
 * parameter is for, and it is what makes this page follow a language switch in
 * the app rather than guessing from the browser — which is the bug that made it
 * render English inside a Spanish or Japanese interface. Only a page opened
 * directly (no parameter) falls back to the browser's preferences.
 * @returns one of `SUPPORTED_LOCALES`.
 */
function pickLocale(): string {
  const asked = new URLSearchParams(window.location.search).get('lang')
  if (asked !== null) return langOf(asked)
  for (const tag of navigator.languages ?? [navigator.language]) {
    const lower = tag.toLowerCase()
    // A region subtag matches (`es-419` is Spanish); a word that merely begins
    // with those letters does not (`est` is not `es`).
    const hit = SUPPORTED_LOCALES.find(id => lower === id || lower.startsWith(`${id}-`))
    if (hit !== undefined) return hit
  }
  return 'en'
}

/**
 * The page body.
 * @returns the panel, translated, sized to the window.
 */
function Viewer(): ReactNode {
  const [locale] = useState<string>(pickLocale)
  const [height, setHeight] = useState(520)
  const [clientReport, setClientReport] = useState<ClientGraphReport | null>(null)
  // Stable identity across renders: a fresh arrow here would change a prop the
  // panel's fetch effect depends on, re-reading the graph on every render.
  const clientGraph = useMemo(
    (): (() => PluginGraph) | null => (clientReport === null ? null : () => clientReport.graph),
    [clientReport],
  )

  // The browser tree cannot be collected on THIS page: it has no client Cordis,
  // which is the whole reason the app reports its copy to the host. A 404 simply
  // means no app has looked at that runtime yet, and the panel then shows the
  // host's graph alone.
  useEffect(() => {
    let live = true
    void fetch(CLIENT_GRAPH_PATH, { cache: 'no-store' })
      .then(async (response) => (response.ok ? (await response.json()) as ClientGraphReport : null))
      .then((report) => { if (live && report !== null) setClientReport(report) })
      .catch(() => undefined)
    return () => { live = false }
  }, [])

  useEffect(() => {
    const measure = (): void => {
      // Floored so a short window still gets a usable drawing and scrolls the
      // rest, rather than collapsing to a strip.
      setHeight(Math.max(320, window.innerHeight - CHROME_HEIGHT))
    }
    measure()
    window.addEventListener('resize', measure)
    return () => { window.removeEventListener('resize', measure) }
  }, [])

  const t = useCallback<Translate>(
    // `?? en` is unreachable in practice — `locale` comes from `langOf` or from
    // `SUPPORTED_LOCALES`, both of which answer with a dictionary that exists —
    // but it is what lets the index be typed without an assertion.
    (key, params) => interpolate((DICTIONARIES[locale] ?? en)[key], params),
    [locale],
  )

  // Set from the dictionary rather than hardcoded in the document, so the tab
  // title and the on-page heading agree. Reaches the tab a moment after paint on
  // a page opened directly; the served document already carries both for the case
  // the app opened it (see ../viewer-page.ts).
  useEffect(() => {
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : locale
    document.title = (DICTIONARIES[locale] ?? en).title
  }, [locale])

  return createElement(GraphPanel, {
    t,
    viewerPath: null,
    canvasHeight: height,
    // Spread rather than two nullable props: the panel shows the scope pair only
    // when it CAN collect that tree, and here it cannot — it only displays one
    // somebody else collected. The collector is memoised so its identity is stable
    // between renders: a fresh arrow would re-run the panel's fetch effect on every
    // render of this page.
    ...(clientGraph === null || clientReport === null
      ? {}
      : { clientGraph, clientGraphAt: clientReport.at }),
  })
}

// The page's color scheme follows the app's, reported through the URL the panel
// opened this page with. Applied at module scope BEFORE the first render: a theme
// that flips a frame after paint is a visible flash, and the tokens this page
// loads switch on this very attribute.
const scheme = new URLSearchParams(window.location.search).get('scheme') === 'light'
  ? 'light'
  : 'dark'
document.documentElement.style.colorScheme = scheme
document.body.toggleAttribute('data-ds-dark-theme', scheme === 'dark')

const host = document.getElementById('root')
if (host !== null) createRoot(host).render(createElement(Viewer))
