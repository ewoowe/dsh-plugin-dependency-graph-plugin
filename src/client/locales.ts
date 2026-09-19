/**
 * Plugin-graph copy.
 *
 * `zh` and `en` are the locales the shell ships, so they register together as
 * the typed `Record<BuiltInLocaleId, …>` form. The rest are language-pack
 * locales: the pack owns the DEFINITION that makes them selectable, and this
 * plugin contributes only its own namespace to each. It deliberately does not
 * call `addLanguage` — that would throw against an existing definition.
 *
 * Every dictionary is typed `Record<MessagesKey, string>`, so a key added to the
 * union fails to compile until all seven translations exist; the `en` fallback
 * chain would otherwise let a forgotten key resolve silently.
 */

/** Locale namespace owned by this plugin. */
export const NS = 'pluginGraph'

/** The keys this plugin's two dictionaries carry. */
export type MessagesKey =
  | 'title'
  | 'intro'
  | 'introClient'
  | 'clientCollectedAt'
  | 'scopeHost'
  | 'scopeClient'
  | 'refresh'
  | 'loading'
  | 'failed'
  | 'statPlugins'
  | 'statEdges'
  | 'statUnresolved'
  | 'sectionGraph'
  | 'sectionDetail'
  | 'selectHint'
  | 'graphHint'
  | 'zoomIn'
  | 'zoomOut'
  | 'fitView'
  // Selection history: back and forward between the nodes a reader visited.
  | 'historyBack'
  | 'historyForward'
  | 'fullscreen'
  | 'exitFullscreen'
  | 'openInTab'
  | 'searchPlaceholder'
  | 'searchClear'
  | 'searchMatches'
  | 'searchNone'
  | 'provides'
  | 'listens'
  | 'nothingListens'
  | 'injects'
  | 'injectsOptional'
  | 'nothingProvides'
  | 'nothingInjects'
  | 'nothingInjectsOptional'
  | 'optionalMark'
  | 'usedBy'
  | 'dependsOn'
  | 'noUsedBy'
  | 'noDependsOn'
  // The legend's runtime pair: the same two directions, for edges that are drawn
  // dashed because the dependency is only acquired at runtime.
  | 'optionalOut'
  | 'optionalIn'
  | 'unresolvedTitle'
  | 'isolatedTitle'
  | 'unresolvedNone'
  | 'isolatedNone'
  | 'stateActive'
  | 'stateFailed'
  | 'stateOther'
  | 'statePending'
  | 'stateLoading'
  | 'stateUnloading'
  | 'stateDisposed'
  | 'stateUnloaded'
  | 'statusTitle'

const en: Record<MessagesKey, string> = {
  title: 'Plugin graph',
  intro: 'Which plugin provides the services every other plugin injects, read from the live Cordis runtime.',
  introClient: 'The browser half is a separate Cordis runtime with its own plugins and its own service names. The two graphs are not comparable and are never merged — a merged one would be a wrong one, not a bigger one.',
  clientCollectedAt: 'Browser tree collected {when}.',
  scopeHost: 'Host',
  scopeClient: 'Browser',
  refresh: 'Refresh',
  loading: 'Reading the runtime…',
  failed: 'Could not read the graph.',
  statPlugins: '{value} plugins',
  statEdges: '{value} dependencies',
  statUnresolved: '{value} unresolved',
  sectionGraph: 'Dependency graph',
  sectionDetail: 'Detail',
  selectHint: 'Pick a node to see what it provides and what it depends on.',
  graphHint: 'Scroll to zoom · drag to pan · click a node',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  fitView: 'Reset view',
  historyBack: 'Back',
  historyForward: 'Forward',
  fullscreen: 'Fullscreen',
  exitFullscreen: 'Exit fullscreen',
  openInTab: 'Open in a new tab',
  searchPlaceholder: 'Find a plugin…',
  searchClear: 'Clear search',
  searchMatches: '{value} matched',
  searchNone: 'No match',
  provides: 'Provides',
  listens: 'Listens to',
  nothingListens: 'Listens to no events.',
  injects: 'Injects',
  injectsOptional: 'Injected at runtime',
  nothingProvides: 'Provides no services.',
  nothingInjects: 'Injects no services.',
  nothingInjectsOptional: 'Injects nothing at runtime.',
  optionalMark: 'optional',
  usedBy: 'Used by',
  dependsOn: 'Depends on',
  noUsedBy: 'Nothing depends on it.',
  noDependsOn: 'It depends on nothing in this composition.',
  optionalOut: 'Depends at runtime',
  optionalIn: 'Used at runtime',
  unresolvedTitle: 'Unresolved dependencies',
  isolatedTitle: 'Isolated services',
  unresolvedNone: 'Every injected service has a provider.',
  isolatedNone: 'No service is provided under more than one isolation label.',
  stateActive: 'active',
  stateFailed: 'failed',
  stateOther: 'unknown',
  // The five states the canvas used to fold into one word. `collect.ts` always
  // read them apart; this is the renderer finally saying so.
  statePending: 'pending',
  stateLoading: 'loading',
  stateUnloading: 'unloading',
  stateDisposed: 'disposed',
  stateUnloaded: 'not loaded',
  statusTitle: 'Status',
}

const zh: Record<MessagesKey, string> = {
  title: '插件依赖图',
  intro: '哪个插件提供了其他插件所注入的服务，数据读自运行中的 Cordis 运行时。',
  introClient: '浏览器侧是另一套 Cordis 运行时：不同的插件、不同的服务名。两张图不可比较、也不合并——合并出来的不是更大的图，而是错的图。',
  clientCollectedAt: '浏览器侧的树采集于 {when}。',
  scopeHost: '宿主',
  scopeClient: '浏览器',
  refresh: '刷新',
  loading: '正在读取运行时…',
  failed: '无法读取依赖图。',
  statPlugins: '{value} 个插件',
  statEdges: '{value} 条依赖',
  statUnresolved: '{value} 条未解析',
  sectionGraph: '依赖图',
  sectionDetail: '详情',
  selectHint: '点一个节点，看它提供什么、依赖什么。',
  graphHint: '滚轮缩放 · 拖拽平移 · 点击节点',
  zoomIn: '放大',
  zoomOut: '缩小',
  fitView: '重置视图',
  historyBack: '后退',
  historyForward: '前进',
  fullscreen: '全屏',
  exitFullscreen: '退出全屏',
  openInTab: '新标签页打开',
  searchPlaceholder: '查找插件…',
  searchClear: '清除搜索',
  searchMatches: '匹配 {value} 个',
  searchNone: '无匹配',
  provides: '提供',
  listens: '监听的事件',
  nothingListens: '不监听任何事件。',
  injects: '注入',
  injectsOptional: '运行时注入',
  nothingProvides: '不提供任何服务。',
  nothingInjects: '不注入任何服务。',
  nothingInjectsOptional: '运行时不注入任何服务。',
  optionalMark: '可选',
  usedBy: '被依赖',
  dependsOn: '依赖',
  noUsedBy: '没有插件依赖它。',
  noDependsOn: '在本组合里它不依赖任何插件。',
  optionalOut: '运行时依赖',
  optionalIn: '运行时被依赖',
  unresolvedTitle: '未解析的依赖',
  isolatedTitle: '被隔离的服务',
  unresolvedNone: '每个被注入的服务都有提供者。',
  isolatedNone: '没有服务在多个隔离标签下提供。',
  stateActive: '已激活',
  stateFailed: '失败',
  stateOther: '未知',
  statePending: '待加载',
  stateLoading: '加载中',
  stateUnloading: '卸载中',
  stateDisposed: '已卸载',
  stateUnloaded: '未加载',
  statusTitle: '状态',
}

/** Japanese. Terminology follows `session-messages`' dictionary where it overlaps. */
const ja: Record<MessagesKey, string> = {
  title: 'プラグインの依存グラフ',
  intro: '他のプラグインが注入するサービスをどのプラグインが提供しているかを、実行中の Cordis ランタイムから読み取ります。',
  introClient: 'ブラウザ側は別の Cordis ランタイムで、プラグインもサービス名も別です。二つのグラフは比較できず、統合もしません——統合したものは大きい図ではなく、誤った図になります。',
  clientCollectedAt: 'ブラウザ側のツリーを {when} に収集。',
  scopeHost: 'ホスト',
  scopeClient: 'ブラウザ',
  refresh: '更新',
  loading: 'ランタイムを読み取り中…',
  failed: '依存グラフを読み取れませんでした。',
  statPlugins: 'プラグイン {value} 個',
  statEdges: '依存 {value} 件',
  statUnresolved: '未解決 {value} 件',
  sectionGraph: '依存グラフ',
  sectionDetail: '詳細',
  selectHint: 'ノードを選ぶと、提供しているものと依存しているものを表示します。',
  graphHint: 'スクロールでズーム · ドラッグで移動 · クリックで選択',
  zoomIn: '拡大',
  zoomOut: '縮小',
  fitView: '表示をリセット',
  historyBack: '戻る',
  historyForward: '進む',
  fullscreen: '全画面',
  exitFullscreen: '全画面を終了',
  openInTab: '新しいタブで開く',
  searchPlaceholder: 'プラグインを検索…',
  searchClear: '検索をクリア',
  searchMatches: '{value} 件一致',
  searchNone: '一致なし',
  provides: '提供',
  listens: '購読するイベント',
  nothingListens: 'イベントを購読していません。',
  injects: '注入',
  injectsOptional: '実行時注入',
  nothingProvides: 'サービスを提供していません。',
  nothingInjects: 'サービスを注入していません。',
  nothingInjectsOptional: '実行時には何も注入していません。',
  optionalMark: '任意',
  usedBy: '被依存',
  dependsOn: '依存先',
  noUsedBy: 'これに依存するプラグインはありません。',
  noDependsOn: 'この構成内で依存しているものはありません。',
  optionalOut: '実行時に依存',
  optionalIn: '実行時に被依存',
  unresolvedTitle: '未解決の依存',
  isolatedTitle: '分離されたサービス',
  unresolvedNone: '注入されるサービスにはすべて提供元があります。',
  isolatedNone: '複数の分離ラベルで提供されているサービスはありません。',
  stateActive: '有効',
  stateFailed: '失敗',
  stateOther: '不明',
  statePending: '待機中',
  stateLoading: '読み込み中',
  stateUnloading: '解放中',
  stateDisposed: '破棄済み',
  stateUnloaded: '未読み込み',
  statusTitle: '状態',
}

/** Korean. Terminology follows `session-messages`' dictionary where it overlaps. */
const ko: Record<MessagesKey, string> = {
  title: '플러그인 의존성 그래프',
  intro: '다른 플러그인이 주입하는 서비스를 어떤 플러그인이 제공하는지, 실행 중인 Cordis 런타임에서 읽습니다.',
  introClient: '브라우저 쪽은 별도의 Cordis 런타임이며 플러그인도 서비스 이름도 다릅니다. 두 그래프는 비교할 수 없고 병합하지도 않습니다——병합한 것은 더 큰 그림이 아니라 잘못된 그림입니다.',
  clientCollectedAt: '브라우저 쪽 트리를 {when}에 수집했습니다.',
  scopeHost: '호스트',
  scopeClient: '브라우저',
  refresh: '새로 고침',
  loading: '런타임을 읽는 중…',
  failed: '그래프를 읽을 수 없습니다.',
  statPlugins: '플러그인 {value}개',
  statEdges: '의존성 {value}개',
  statUnresolved: '미해결 {value}개',
  sectionGraph: '의존성 그래프',
  sectionDetail: '상세',
  selectHint: '노드를 선택하면 제공하는 것과 의존하는 것을 볼 수 있습니다.',
  graphHint: '스크롤로 확대 · 드래그로 이동 · 클릭으로 선택',
  zoomIn: '확대',
  zoomOut: '축소',
  fitView: '보기 초기화',
  historyBack: '뒤로',
  historyForward: '앞으로',
  fullscreen: '전체 화면',
  exitFullscreen: '전체 화면 종료',
  openInTab: '새 탭에서 열기',
  searchPlaceholder: '플러그인 검색…',
  searchClear: '검색 지우기',
  searchMatches: '{value}개 일치',
  searchNone: '일치 없음',
  provides: '제공',
  listens: '수신하는 이벤트',
  nothingListens: '이벤트를 수신하지 않습니다.',
  injects: '주입',
  injectsOptional: '런타임 주입',
  nothingProvides: '제공하는 서비스가 없습니다.',
  nothingInjects: '주입하는 서비스가 없습니다.',
  nothingInjectsOptional: '런타임에는 아무것도 주입하지 않습니다.',
  optionalMark: '선택',
  usedBy: '사용하는 곳',
  dependsOn: '의존 대상',
  noUsedBy: '이것에 의존하는 플러그인이 없습니다.',
  noDependsOn: '이 구성에서 의존하는 것이 없습니다.',
  optionalOut: '런타임 의존',
  optionalIn: '런타임 피의존',
  unresolvedTitle: '미해결 의존성',
  isolatedTitle: '격리된 서비스',
  unresolvedNone: '주입되는 모든 서비스에 제공자가 있습니다.',
  isolatedNone: '여러 격리 라벨로 제공되는 서비스는 없습니다.',
  stateActive: '활성',
  stateFailed: '실패',
  stateOther: '알 수 없음',
  statePending: '대기 중',
  stateLoading: '로드 중',
  stateUnloading: '해제 중',
  stateDisposed: '해제됨',
  stateUnloaded: '로드되지 않음',
  statusTitle: '상태',
}

/** Spanish. Terminology follows `session-messages`' dictionary where it overlaps. */
const es: Record<MessagesKey, string> = {
  title: 'Grafo de plugins',
  intro: 'Qué plugin provee los servicios que los demás inyectan, leído del runtime de Cordis en vivo.',
  introClient: 'El lado del navegador es otro runtime de Cordis, con sus propios plugins y sus propios nombres de servicio. Los dos grafos no son comparables y nunca se fusionan: uno fusionado sería un grafo equivocado, no uno más grande.',
  clientCollectedAt: 'Árbol del navegador recogido el {when}.',
  scopeHost: 'Host',
  scopeClient: 'Navegador',
  refresh: 'Actualizar',
  loading: 'Leyendo el runtime…',
  failed: 'No se pudo leer el grafo.',
  statPlugins: '{value} plugins',
  statEdges: '{value} dependencias',
  statUnresolved: '{value} sin resolver',
  sectionGraph: 'Grafo de dependencias',
  sectionDetail: 'Detalle',
  selectHint: 'Elige un nodo para ver qué provee y de qué depende.',
  graphHint: 'Rueda para ampliar · arrastra para mover · clic en un nodo',
  zoomIn: 'Acercar',
  zoomOut: 'Alejar',
  fitView: 'Restablecer vista',
  historyBack: 'Atrás',
  historyForward: 'Adelante',
  fullscreen: 'Pantalla completa',
  exitFullscreen: 'Salir de pantalla completa',
  openInTab: 'Abrir en una pestaña nueva',
  searchPlaceholder: 'Buscar un plugin…',
  searchClear: 'Borrar la búsqueda',
  searchMatches: '{value} coincidencias',
  searchNone: 'Sin coincidencias',
  provides: 'Provee',
  listens: 'Escucha',
  nothingListens: 'No escucha ningún evento.',
  injects: 'Inyecta',
  injectsOptional: 'Inyectado en tiempo de ejecución',
  nothingProvides: 'No provee ningún servicio.',
  nothingInjects: 'No inyecta ningún servicio.',
  nothingInjectsOptional: 'No inyecta nada en tiempo de ejecución.',
  optionalMark: 'opcional',
  usedBy: 'Lo usan',
  dependsOn: 'Depende de',
  noUsedBy: 'Nada depende de él.',
  noDependsOn: 'No depende de nada en esta composición.',
  optionalOut: 'Depende en ejecución',
  optionalIn: 'Se usa en ejecución',
  unresolvedTitle: 'Dependencias sin resolver',
  isolatedTitle: 'Servicios aislados',
  unresolvedNone: 'Todo servicio inyectado tiene proveedor.',
  isolatedNone: 'Ningún servicio se provee bajo más de una etiqueta de aislamiento.',
  stateActive: 'activo',
  stateFailed: 'fallido',
  stateOther: 'desconocido',
  statePending: 'pendiente',
  stateLoading: 'cargando',
  stateUnloading: 'descargando',
  stateDisposed: 'liberado',
  stateUnloaded: 'sin cargar',
  statusTitle: 'Estado',
}

/** French. Terminology follows `session-messages`' dictionary where it overlaps. */
const fr: Record<MessagesKey, string> = {
  title: 'Graphe des plugins',
  intro: 'Quel plugin fournit les services que les autres injectent, lu depuis le runtime Cordis en direct.',
  introClient: 'Le côté navigateur est un autre runtime Cordis, avec ses propres plugins et ses propres noms de service. Les deux graphes ne sont pas comparables et ne sont jamais fusionnés : un graphe fusionné serait un graphe faux, pas un plus grand.',
  clientCollectedAt: 'Arbre du navigateur collecté le {when}.',
  scopeHost: 'Hôte',
  scopeClient: 'Navigateur',
  refresh: 'Actualiser',
  loading: 'Lecture du runtime…',
  failed: 'Impossible de lire le graphe.',
  statPlugins: '{value} plugins',
  statEdges: '{value} dépendances',
  statUnresolved: '{value} non résolues',
  sectionGraph: 'Graphe de dépendances',
  sectionDetail: 'Détail',
  selectHint: 'Choisissez un nœud pour voir ce qu’il fournit et ce dont il dépend.',
  graphHint: 'Molette pour zoomer · glisser pour déplacer · clic sur un nœud',
  zoomIn: 'Zoom avant',
  zoomOut: 'Zoom arrière',
  fitView: 'Réinitialiser la vue',
  historyBack: 'Retour',
  historyForward: 'Suivant',
  fullscreen: 'Plein écran',
  exitFullscreen: 'Quitter le plein écran',
  openInTab: 'Ouvrir dans un nouvel onglet',
  searchPlaceholder: 'Rechercher un plugin…',
  searchClear: 'Effacer la recherche',
  searchMatches: '{value} correspondances',
  searchNone: 'Aucune correspondance',
  provides: 'Fournit',
  listens: 'Écoute',
  nothingListens: 'N’écoute aucun événement.',
  injects: 'Injecte',
  injectsOptional: 'Injecté à l’exécution',
  nothingProvides: 'Ne fournit aucun service.',
  nothingInjects: 'N’injecte aucun service.',
  nothingInjectsOptional: 'N’injecte rien à l’exécution.',
  optionalMark: 'optionnel',
  usedBy: 'Utilisé par',
  dependsOn: 'Dépend de',
  noUsedBy: 'Rien n’en dépend.',
  noDependsOn: 'Ne dépend de rien dans cette composition.',
  optionalOut: 'Dépend à l’exécution',
  optionalIn: 'Utilisé à l’exécution',
  unresolvedTitle: 'Dépendances non résolues',
  isolatedTitle: 'Services isolés',
  unresolvedNone: 'Chaque service injecté a un fournisseur.',
  isolatedNone: 'Aucun service n’est fourni sous plus d’une étiquette d’isolation.',
  stateActive: 'actif',
  stateFailed: 'en échec',
  stateOther: 'inconnu',
  statePending: 'en attente',
  stateLoading: 'chargement',
  stateUnloading: 'déchargement',
  stateDisposed: 'libéré',
  stateUnloaded: 'non chargé',
  statusTitle: 'État',
}

/** German. Terminology follows `session-messages`' dictionary where it overlaps. */
const de: Record<MessagesKey, string> = {
  title: 'Plugin-Graph',
  intro: 'Welches Plugin die Dienste bereitstellt, die alle anderen injizieren — gelesen aus der laufenden Cordis-Runtime.',
  introClient: 'Die Browserseite ist eine eigene Cordis-Runtime mit eigenen Plugins und eigenen Dienstnamen. Die beiden Graphen sind nicht vergleichbar und werden nie zusammengeführt — ein zusammengeführter wäre ein falscher Graph, kein größerer.',
  clientCollectedAt: 'Browser-Baum erfasst am {when}.',
  scopeHost: 'Host',
  scopeClient: 'Browser',
  refresh: 'Aktualisieren',
  loading: 'Runtime wird gelesen…',
  failed: 'Der Graph konnte nicht gelesen werden.',
  statPlugins: '{value} Plugins',
  statEdges: '{value} Abhängigkeiten',
  statUnresolved: '{value} unaufgelöst',
  sectionGraph: 'Abhängigkeitsgraph',
  sectionDetail: 'Details',
  selectHint: 'Knoten auswählen, um zu sehen, was er bereitstellt und wovon er abhängt.',
  graphHint: 'Scrollen zum Zoomen · ziehen zum Verschieben · Knoten anklicken',
  zoomIn: 'Vergrößern',
  zoomOut: 'Verkleinern',
  fitView: 'Ansicht zurücksetzen',
  historyBack: 'Zurück',
  historyForward: 'Vor',
  fullscreen: 'Vollbild',
  exitFullscreen: 'Vollbild beenden',
  openInTab: 'In neuem Tab öffnen',
  searchPlaceholder: 'Plugin suchen…',
  searchClear: 'Suche löschen',
  searchMatches: '{value} Treffer',
  searchNone: 'Kein Treffer',
  provides: 'Bietet',
  listens: 'Empfängt',
  nothingListens: 'Empfängt keine Ereignisse.',
  injects: 'Injiziert',
  injectsOptional: 'Zur Laufzeit injiziert',
  nothingProvides: 'Bietet keine Dienste.',
  nothingInjects: 'Injiziert keine Dienste.',
  nothingInjectsOptional: 'Injiziert zur Laufzeit nichts.',
  optionalMark: 'optional',
  usedBy: 'Genutzt von',
  dependsOn: 'Hängt ab von',
  noUsedBy: 'Nichts hängt davon ab.',
  noDependsOn: 'Hängt in dieser Komposition von nichts ab.',
  // Nouns where the pair above is a verb phrase: `Hängt zur Laufzeit ab` would
  // wrap the legend onto a second line for no gain.
  optionalOut: 'Laufzeit-Abhängigkeit',
  optionalIn: 'Laufzeit-Nutzung',
  unresolvedTitle: 'Unaufgelöste Abhängigkeiten',
  isolatedTitle: 'Isolierte Dienste',
  unresolvedNone: 'Jeder injizierte Dienst hat einen Anbieter.',
  isolatedNone: 'Kein Dienst wird unter mehr als einem Isolationslabel bereitgestellt.',
  stateActive: 'aktiv',
  stateFailed: 'fehlgeschlagen',
  stateOther: 'unbekannt',
  statePending: 'ausstehend',
  stateLoading: 'lädt',
  stateUnloading: 'entlädt',
  stateDisposed: 'freigegeben',
  stateUnloaded: 'nicht geladen',
  statusTitle: 'Status',
}

/**
 * The dictionaries beyond the two the shell ships, keyed by language-pack
 * locale id. Every one of them falls back to `en`, so a key missing here would
 * still resolve rather than print itself — which is exactly why the shared
 * `Record<MessagesKey, string>` type matters more than the fallback does.
 */
const PACK_LOCALES: Readonly<Record<string, Record<MessagesKey, string>>> = { ja, ko, es, fr, de }

/**
 * Every locale this plugin carries a dictionary for, in the picker's own order.
 *
 * A list rather than `Object.keys(DICTIONARIES)`: the standalone viewer walks it
 * against `navigator.languages`, where order decides which of several matches
 * wins, and an object's key order is a thing nobody should be relying on.
 */
const SUPPORTED_LOCALES = ['zh', 'en', 'ja', 'ko', 'es', 'fr', 'de'] as const

/**
 * Every dictionary by locale id — the app's own, and the standalone viewer's.
 *
 * One table for both halves because there are two consumers and one truth: the
 * app resolves strings through the locale service, and the viewer (a page with no
 * cordis runtime) resolves them through this table directly.
 */
const DICTIONARIES: Readonly<Record<string, Record<MessagesKey, string>>> = { zh, en, ...PACK_LOCALES }

/**
 * English, the fallback the host also declares. Deliberately NOT imported from
 * the host's locale package: this table is also loaded by the Node half, which
 * has no business pulling a browser package in to learn a two-letter string.
 */
const FALLBACK_LOCALE = 'en'

/**
 * A locale id taken from an UNTRUSTED string — the viewer's `?lang=`.
 *
 * Whitelisted rather than sanitised, because the value does two jobs: it picks a
 * dictionary and it is written into the page's `lang` attribute. Anything not in
 * {@link DICTIONARIES} is answered with the fallback, so no string from a URL can
 * reach the document at all.
 *
 * A locale a language pack defines but this plugin carries no dictionary for is
 * not an error — that is a normal state — and English is the honest answer for it.
 * @param asked - the raw value, or null when there was none.
 * @returns one of {@link SUPPORTED_LOCALES}.
 */
export function langOf(asked: string | null): string {
  return asked !== null && Object.hasOwn(DICTIONARIES, asked) ? asked : FALLBACK_LOCALE
}

// `langOf` is declared with `export function` above and is deliberately absent
// here: naming it in both places is a duplicate-export error.
export { DICTIONARIES, en, PACK_LOCALES, SUPPORTED_LOCALES, zh }

/**
 * Translate function bound to this plugin's namespace.
 *
 * Lives here rather than in the section so both halves of the UI — the section
 * chrome and the drawn canvas — take the same seat without one importing the
 * other's component module.
 */
export type Translate = (key: MessagesKey, params?: Record<string, unknown>) => string

/**
 * Register the namespace with the slot renderer.
 *
 * This merge is what puts the typed `t` seat on the section's props and what lets
 * the registration name `pluginGraph` as its locale: without it, cordis refuses
 * the registration outright rather than handing the section an unbound translate.
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    pluginGraph: MessagesKey
  }
}
