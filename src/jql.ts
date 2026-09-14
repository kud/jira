export const jqlEscape = (value: string): string =>
  `"${value.replace(/"/g, '\\"')}"`

export type ListOptions = {
  assignee?: string
  mine?: boolean
  status?: string
  project?: string
  sprint?: string
  label?: string
  jql?: string
}

/**
 * Flags compose into one JQL string rather than each becoming its own command.
 * `--jql` replaces the generated clauses entirely so there is always an escape
 * hatch for anything the flags cannot express.
 */
export const buildJql = (
  options: ListOptions,
  defaultProject?: string,
): string => {
  if (options.jql) return options.jql

  const clauses: string[] = []
  if (options.mine) clauses.push("assignee = currentUser()")
  else if (options.assignee)
    clauses.push(
      options.assignee === "none"
        ? "assignee IS EMPTY"
        : `assignee = ${jqlEscape(options.assignee)}`,
    )

  const project = options.project ?? defaultProject
  if (project) clauses.push(`project = ${jqlEscape(project)}`)
  if (options.status) clauses.push(`status = ${jqlEscape(options.status)}`)
  if (options.label) clauses.push(`labels = ${jqlEscape(options.label)}`)
  if (options.sprint)
    clauses.push(
      options.sprint === "current"
        ? "sprint IN openSprints()"
        : `sprint = ${jqlEscape(options.sprint)}`,
    )

  // Jira rejects an unbounded query outright, so a bare `issue list` has to
  // mean something. Yours is the only defensible default.
  if (clauses.length === 0) clauses.push("assignee = currentUser()")

  return `${clauses.join(" AND ")} ORDER BY updated DESC`
}

export type SearchMode = "auto" | "jql" | "text"

/**
 * The tell for JQL is the SHAPE of the first clause — `identifier operator` —
 * not the presence of an operator somewhere. Every JQL clause opens that way
 * and no natural phrase does, so "in progress" stays words while
 * "status = broken" is a query (a wrong one, which Jira then says in its own
 * words). Never try-as-JQL: too many phrases parse.
 */
// The wordy operators are held to their JQL grammar — `is` wants EMPTY or
// NULL, `in` wants a list — so "what is the total" and "in progress" stay words.
const WORD_OPS = [
  String.raw`\s+(not\s+)?in\s*\(`,
  String.raw`\s+is\s+(not\s+)?(empty|null)\b`,
  String.raw`\s+was\s+(not\s+)?(in\s*\(|"|'|empty|null)`,
  String.raw`\s+changed\s*(by|after|before|during|on|from|to|$)`,
].join("|")
const JQL_SHAPE = new RegExp(
  String.raw`^\(?\s*(not\s+)?\(?\s*[\w.\-[\]"]+\s*(=|!=|~|!~|<=|>=|<|>|` + WORD_OPS + ")",
  "i",
)
const ORDER_ONLY = /^order\s+by\s/i

export const looksLikeJql = (input: string): boolean => {
  const s = input.trim()
  return JQL_SHAPE.test(s) || ORDER_ONLY.test(s)
}

// Jira's `~` hands the value to Lucene, where these are syntax: a search for
// `c++` throws unless each is escaped.
const LUCENE_SPECIALS = /([+\-&|!(){}[\]^~*?:\\])/g

export const textClause = (words: string): string =>
  `text ~ ${jqlEscape(words.replace(LUCENE_SPECIALS, "\\$1"))}`

/**
 * What a search box submission becomes. Plain words search WITHIN the scope
 * handed in (the list the user is looking at); JQL replaces it, because the
 * user has asked for something else. The two differ on purpose and the
 * screen names which is in force.
 */
export const searchJql = (
  input: string,
  { mode = "auto", scope }: { mode?: SearchMode; scope?: string } = {},
): { jql: string; mode: "jql" | "text" } => {
  const trimmed = input.trim()
  const isJql = mode === "jql" || (mode === "auto" && looksLikeJql(trimmed))
  if (isJql) return { jql: trimmed, mode: "jql" }
  const clauses = [scope, textClause(trimmed)].filter(Boolean)
  return { jql: `${clauses.join(" AND ")} ORDER BY updated DESC`, mode: "text" }
}
