/**
 * Attach package descriptions to a graph, from a name → description lookup.
 *
 * Pure, and deliberately in its own module: the READING of a `package.json` can
 * only happen on the Node half, but the MERGING has to happen on both — the app
 * collects the browser tree in the page and attaches descriptions there, and the
 * host's route attaches them to its own. Keeping the merge here means the browser
 * bundle never touches `node:fs` while both halves still run one implementation.
 *
 * Keyed by NAME, not by node id: the two runtimes give the same packages
 * different entry ids (and the browser tree has entries the host never loaded),
 * but a package name means the same thing on both sides — it is the one key a
 * description can be shared under.
 * @module dsh-plugin-graph/describe
 */
import type { PluginGraph } from './graph-types.ts'

/**
 * A graph with every description the lookup can answer for.
 *
 * A node that already carries one is left alone: the host sends its graph with
 * descriptions already attached, and a page that re-applies a lookup must not be
 * able to blank one out. A node the lookup cannot answer for keeps NO field at
 * all rather than an empty string — the detail panel then draws no line, which is
 * the truthful rendering of "this package does not say".
 * @param graph - the graph to decorate.
 * @param lookup - description by package name; absent names are skipped.
 * @returns a new graph; the input is not modified.
 */
export function applyDescriptions(
  graph: PluginGraph,
  lookup: Readonly<Record<string, string>>,
): PluginGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      if (node.description !== undefined) return node
      const description = lookup[node.name]
      return description === undefined ? node : { ...node, description }
    }),
  }
}
