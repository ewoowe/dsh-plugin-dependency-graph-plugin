/**
 * Browser half of the plugin-graph plugin.
 *
 * One contribution: a read-only settings section showing the host's plugin
 * dependency graph. It is a settings section rather than a conversation view
 * because the graph is a property of the DEPLOYMENT — every session sees the same
 * one — so a per-session tab would imply something that is not true.
 *
 * The panel itself lives in ./GraphPanel.tsx, because the standalone viewer page
 * renders that same panel outside the app (see ../viewer/main.tsx). What is
 * decided HERE is only the slot contract: the dictionaries, the nav label, and
 * that this host is the one offering to open the viewer in a new tab.
 *
 * The data arrives over HTTP (see the Node half) rather than through a remote
 * call: the graph is a plain JSON snapshot, and a route keeps this plugin from
 * having to own and version an RPC contract for it.
 */
import { createElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only merges: these pull in ctx.slots and ctx.locale.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { collectGraph } from '../collect.ts'
import { VIEWER_PATH, type PluginGraph } from '../graph-types.ts'
import { GraphPanel } from './GraphPanel.tsx'
import { en, NS, PACK_LOCALES, zh } from './locales.ts'

/** Props the renderer binds for this section. */
type SectionProps = PropsRuntime<'settings.section'> & PropsLocale<typeof NS>

/**
 * Services required before the section can register.
 *
 * A module-level declaration, not just the nested scope below, because `apply`
 * touches `locale` OUTSIDE that scope: the dictionaries have to register before
 * any slot resolves a string, and cordis refuses a property read on a service the
 * plugin never declared.
 */
export const inject = ['slots', 'locale']

/**
 * Register the section.
 * @param ctx - owning client context.
 */
export function apply(ctx: Context): void {
  // `zh` and `en` are the locales the shell ships, so both go in through the
  // multi-locale overload. The language-pack locales go in one at a time, through
  // the single-locale overload the docs reserve for exactly this: the pack owns
  // the DEFINITION that makes a language selectable, and this plugin contributes
  // only its own namespace to each. Same arrangement as `session-messages-plugin`.
  ctx.effect(() => {
    const disposers = [
      ctx.locale.register(NS, { zh, en }),
      ...Object.entries(PACK_LOCALES)
        .map(([locale, dict]) => ctx.locale.register(NS, locale, dict)),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'plugin-graph: dictionaries')

  // Defined ONCE here rather than inline in the render below: a fresh arrow per
  // render would hand GraphPanel a new `clientGraph` prop each time, which re-runs
  // its fetch effect -- the "second refresh" the reader saw.
  const clientGraph = (): PluginGraph => collectGraph(ctx.root)

  ctx.inject(['slots', 'locale'], (scope: Context) => {
    // Bound once, resolved per read, so the section's nav label follows a locale
    // switch without re-registering.
    const t = scope.locale.bind(NS)
    scope.slots.inject('settings.section', () => scope.slots.register({
      name: 'settings.section',
      id: 'plugin-graph',
      // After the shipped sections: a diagnostic surface is not where a reader
      // starts, and it should not push them around either.
      order: 50,
      label: () => t('title'),
      locale: NS,
    }, (props: SectionProps) => createElement(GraphPanel, {
      t: props.t,
      // This host is the one with somewhere to send the reader; the viewer
      // renders the same panel with `viewerPath: null`.
      viewerPath: VIEWER_PATH,
      // The live locale, read when the reader opens the tab: the viewer is a page
      // the Node half serves and has no locale service to ask, so the app has to
      // say which language it is in. `getSnapshot().active` is the host's own
      // read — the same one `ui-settings-general` uses.
      activeLocale: () => scope.locale.getSnapshot().active,
      // The browser's own tree, collected on demand from the PAGE's root context
      // — not from this plugin's scope, which sees only its own fibers. It is the
      // same collector the host route runs; see ../collect.ts for why that had to
      // become one function instead of two.
      clientGraph,
    })))
  })
}
