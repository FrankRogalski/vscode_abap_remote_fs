/**
 * Read-only systems (`"readOnly": true` on a system in the config).
 *
 * Enforced twice, so a misclassified or new tool cannot slip through:
 *   1. tool level: before a tool runs, a write tool that names a read-only system is refused
 *      (TOOL_ACCESS; tools missing from the table count as writes)
 *   2. ADT level: the methods of upstream's ADT client that change the system or execute code
 *      reject for clients of read-only systems, whichever code path calls them
 * Tests fail when upstream adds a tool or the ADT library adds a method nobody classified yet.
 */
export type Access = "read" | "write"
type Rule = Access | ((input: Record<string, unknown>) => Access)

const writeWhen =
  (key: string, ...values: string[]): Rule =>
  input =>
    values.includes(String(input[key] ?? "")) ? "write" : "read"
const readWhen =
  (key: string, ...values: string[]): Rule =>
  input =>
    values.includes(String(input[key] ?? "")) ? "read" : "write"

/** "write" = changes the SAP system or executes code on it (unit tests, debugger) */
export const TOOL_ACCESS: Record<string, Rule> = {
  // repository: reads
  abapfs_search_objects: "read",
  abapfs_get_object_source: "read",
  abapfs_search_object_source: "read",
  abapfs_get_object_info: "read",
  abapfs_batch_get_lines: "read",
  abapfs_get_object_by_uri: "read",
  abapfs_get_object_url: "read",
  abapfs_get_workspace_uri: "read",
  abapfs_open_object: "read",
  abapfs_download_object: "read",
  abapfs_find_usages: "read",
  abapfs_analyze_object_relations: "read",
  abapfs_get_version_history: "read",
  abapfs_get_object_transport_status: "read",
  abapfs_manage_transports: readWhen(
    "action",
    "get_user_transports",
    "get_transport_details",
    "get_transport_objects",
    "compare_transports"
  ),
  get_abap_diagnostics: "read", // syntax check, changes nothing
  // repository: writes
  abapfs_create_object: "write",
  abapfs_create_test_include: "write",
  replace_string_in_abap_object: "write",
  abapfs_manage_text_elements: readWhen("action", "read"),
  abapfs_activate_object: writeWhen("action", "activate"),
  // analysis
  abapfs_run_sql_query: "read", // SELECT only (ADT data preview)
  abapfs_get_sql_syntax: "read",
  abapfs_run_atc_analysis: "read", // creates a check run, changes no objects
  abapfs_get_atc_highlights: "read",
  abapfs_analyze_dumps: "read",
  abapfs_analyze_traces: readWhen(
    "action",
    "list_runs",
    "list_configurations",
    "analyze_run",
    "get_statements",
    "get_hitlist"
  ),
  abapfs_get_sap_system_info: "read",
  abapfs_export_adt_discovery: "read",
  // executes code on the system
  abapfs_run_unit_tests: "write",
  abapfs_manage_debug_session: readWhen("action", "status", "stop"),
  abapfs_manage_breakpoints: "write",
  abapfs_step_debugger: "write",
  abapfs_inspect_variable: "read",
  abapfs_get_debug_stack: "read",
  abapfs_get_debug_status: "read",
  // local only (no SAP system involved)
  abapfs_get_connected_systems: "read",
  abapfs_get_configured_systems: "read",
  abapfs_create_mermaid_diagram: "read",
  abapfs_validate_mermaid_syntax: "read",
  abapfs_get_mermaid_documentation: "read",
  abapfs_detect_mermaid_diagram_type: "read",
  abapfs_build_test_documentation: "read",
  abapfs_workbook_cell_settings: "read",
  abapfs_search_documentation: "read",
  abapfs_manage_heartbeat: "read",
  abapfs_run_vscode_command: "read"
}

export function toolAccess(name: string, input: unknown): Access {
  const rule = TOOL_ACCESS[name]
  if (!rule) return "write"
  const args = input && typeof input === "object" ? (input as Record<string, unknown>) : {}
  return typeof rule === "function" ? rule(args) : rule
}

export class ReadOnlyError extends Error {}

const refuse = (id: string, what: string) =>
  new ReadOnlyError(
    `${id} is read-only (readOnly in the abapfs config): ${what} would change it or run code on it`
  )

/**
 * Throw when a write tool references a read-only system. `readOnly` maps lower case ids (as
 * found in tool input) to the ids as configured.
 */
export function assertToolAllowed(
  name: string,
  referenced: Set<string>,
  readOnly: Map<string, string>,
  input: unknown = {}
) {
  if (!readOnly.size || toolAccess(name, input) === "read") return
  const hit = [...referenced].find(id => readOnly.has(id))
  if (hit) throw refuse(readOnly.get(hit)!, name)
}

/** ADTClient methods that change the system or execute code */
export const ADT_WRITE_METHODS = [
  "activate",
  "atcChangeContact",
  "atcRequestExemption",
  "changePackageExecute",
  "createLogpoint",
  "createLogPointDefinition",
  "createObject",
  "createTestInclude",
  "createTransport",
  "createTransportsConfig",
  "debuggerAttach",
  "debuggerChangeWatchpoint",
  "debuggerCreateWatchpoint",
  "debuggerListen",
  "debuggerSaveSettings",
  "debuggerSetBreakpoints",
  "debuggerSetVariableValue",
  "debuggerStep",
  "deleteLogpoint",
  "deleteObject",
  "extractMethodExecute",
  "gitCreateRepo",
  "gitPullRepo",
  "gitUnlinkRepo",
  "lock",
  "publishServiceBinding",
  "pushRepo",
  "rapGenGenerate",
  "rapGenPublishService",
  "renameExecute",
  "runClass",
  "setDataElementProperties",
  "setDomainProperties",
  "setObjectSource",
  "setPrettyPrinterSetting",
  "setTextElements",
  "setTransportsConfig",
  "switchRepoBranch",
  "tracesCreateConfiguration",
  "tracesDelete",
  "tracesDeleteConfiguration",
  "tracesSetParameters",
  "transportAddUser",
  "transportDelete",
  "transportRelease",
  "transportSetOwner",
  "unitTestRun",
  "unPublishServiceBinding"
] as const

/** ADTClient methods known to only read (or manage the HTTP session) */
export const ADT_READ_METHODS = [
  "abapDocumentation",
  "adtCompatibiliyGraph",
  "adtCoreDiscovery",
  "adtDiscovery",
  "annotationDefinitions",
  "atcCheckVariant",
  "atcContactUri",
  "atcCustomizing",
  "atcDocumentation",
  "atcExemptProposal",
  "atcUsers",
  "atcWorklists",
  "bindingDetails",
  "changePackagePreview",
  "checkRepo",
  "classComponents",
  "codeCompletion",
  "codeCompletionElement",
  "codeCompletionFull",
  "collectionFeatureDetails",
  "createAtcRun",
  "createHttp", // internal: sets up the HTTP session
  "ddicElement",
  "ddicRepositoryAccess",
  "debuggerChildVariables",
  "debuggerDeleteBreakpoints",
  "debuggerDeleteListener",
  "debuggerDeleteWatchpoint",
  "debuggerGoToStack",
  "debuggerListeners",
  "debuggerStackTrace",
  "debuggerStatements",
  "debuggerVariables",
  "dropSession",
  "dumps",
  "extractMethodEvaluate",
  "extractMethodPreview",
  "featureDetails",
  "feeds",
  "findCollectionByUrl",
  "findDefinition",
  "findObjectPath",
  "fixEdits",
  "fixProposals",
  "fragmentMappings",
  "getDataElementProperties",
  "getDomainProperties",
  "getLogKeys",
  "getLogPointLogs",
  "getLogServers",
  "getObjectSource",
  "getSystemInformation",
  "getTextElements",
  "getTransportConfiguration",
  "gitExternalRepoInfo",
  "gitRepos",
  "inactiveObjects",
  "loadTypes",
  "login",
  "logout",
  "logpoints",
  "mainPrograms",
  "nodeContents",
  "objectEnhancements",
  "objectRegistrationInfo",
  "objectStructure",
  "objectStructureElements",
  "objectTypes",
  "packageSearchHelp",
  "prettyPrinter",
  "prettyPrinterSetting",
  "rapGenGetContent",
  "rapGenGetSchema",
  "rapGenGetUiConfig",
  "rapGenIsAvailable",
  "rapGenPreview",
  "rapGenValidateContent",
  "rapGenValidateInitial",
  "reentranceTicket",
  "remoteRepoInfo",
  "renameEvaluate",
  "renamePreview",
  "revisions",
  "runQuery",
  "searchObject",
  "stageRepo",
  "syntaxCheck",
  "syntaxCheckTypes",
  "systemUsers",
  "tableContents",
  "tracesDbAccess",
  "tracesHitList",
  "tracesList",
  "tracesListRequests",
  "tracesStatements",
  "transportConfigurations",
  "transportDetails",
  "transportInfo",
  "transportReference",
  "transportsByConfig",
  "typeHierarchy",
  "unitTestEvaluation",
  "unitTestOccurrenceMarkers",
  "unLock",
  "usageReferences",
  "usageReferenceSnippets",
  "userTransports",
  "validateNewObject"
] as const

/** Identity of an ADT connection: same server, client and user */
export const clientKey = (baseUrl: string, client: string, username: string) =>
  `${baseUrl.toLowerCase().replace(/\/+$/, "")}|${client}|${username.toUpperCase()}`

const GUARDED = Symbol.for("abapfs.readOnlyGuard")

/**
 * Wrap the write methods of an ADT client prototype. `readOnlySystem(client)` returns the id of
 * the read-only system a client belongs to, or undefined.
 */
export function installAdtGuard(
  proto: any,
  readOnlySystem: (client: any) => string | undefined,
  methods: readonly string[] = ADT_WRITE_METHODS
) {
  for (const name of methods) {
    const original = proto[name]
    if (typeof original !== "function")
      throw new Error(`ADTClient.${name} does not exist anymore: update ADT_WRITE_METHODS`)
    if (original[GUARDED]) continue
    const guarded = function (this: any, ...args: unknown[]) {
      const id = readOnlySystem(this)
      if (id) return Promise.reject(refuse(id, `ADT ${name}`))
      return original.apply(this, args)
    }
    ;(guarded as any)[GUARDED] = true
    proto[name] = guarded
  }
}
