import type {
  JiraBoard,
  JiraChangelogEntry,
  JiraComment,
  JiraComponent,
  JiraCreated,
  JiraEpic,
  JiraFilter,
  JiraIssueLinkType,
  JiraIssueType,
  JiraNamed,
  JiraProjectStatuses,
  JiraVersion,
  JiraWorklog,
  JiraField,
  JiraIssue,
  JiraProject,
  JiraSearchPage,
  JiraSprint,
  JiraTransition,
  JiraUser,
  SearchOptions,
} from "./types.js"

export type JiraCredentials = {
  baseUrl: string
  email: string
  token: string
}

export type JiraClientOptions = JiraCredentials & {
  /** Custom fields to request and label, discovered per instance via `jira fields`. */
  customFields?: { id: string; label: string }[]
  /** The instance's sprint field id, e.g. customfield_10020. */
  sprintField?: string
  fetch?: typeof globalThis.fetch
}

export type JiraApiError = Error & {
  name: "JiraApiError"
  status: number
  method: string
  url: string
  body: string
}

export const jiraApiError = (
  status: number,
  method: string,
  url: string,
  body: string,
): JiraApiError =>
  Object.assign(
    new Error(`Jira API ${status} ${method} ${url}: ${truncate(body)}`),
    { name: "JiraApiError" as const, status, method, url, body },
  )

export const isJiraApiError = (e: unknown): e is JiraApiError =>
  e instanceof Error && e.name === "JiraApiError"

const truncate = (s: string, max = 400): string =>
  s.length > max ? `${s.slice(0, max)}…` : s

/** Accepts `myorg.atlassian.net` as readily as a full URL; a bare host is the
 * common shape of the env var and produces an opaque ERR_INVALID_URL if left. */
export const normalizeBaseUrl = (raw: string): string => {
  const trimmed = raw.trim().replace(/\/+$/, "")
  return /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`
}

const DEFAULT_FIELDS = [
  "summary",
  "status",
  "assignee",
  "issuetype",
  "priority",
  "project",
  "labels",
  "updated",
]

export const createJiraClient = (options: JiraClientOptions) => {
  const doFetch = options.fetch ?? globalThis.fetch
  const baseUrl = normalizeBaseUrl(options.baseUrl)
  const customFields = options.customFields ?? []
  const authHeader = `Basic ${Buffer.from(`${options.email}:${options.token}`).toString("base64")}`

  const request = async <T>(
    path: string,
    init: RequestInit & { raw?: boolean } = {},
  ): Promise<T> => {
    const url = path.startsWith("http")
      ? path
      : `${baseUrl}${path.startsWith("/") ? "" : "/"}${path}`

    const res = await doFetch(url, {
      ...init,
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
        Accept: "application/json",
        // Jira localises error bodies from the account's language. Errors here
        // are read by scripts and pasted into issues, so pin them to English.
        "Accept-Language": "en",
        ...init.headers,
      },
    })

    // `raw` hands back the Response untouched — binary downloads and manual
    // redirect handling both need the headers, not a parsed body.
    if (init.raw) return res as T

    if (!res.ok) {
      throw jiraApiError(
        res.status,
        init.method ?? "GET",
        url,
        await res.text(),
      )
    }
    if (res.status === 204) return undefined as T
    return (await res.json()) as T
  }

  /** Every field the caller cares about, including this instance's custom ones. */
  const fieldList = (extra?: string[]): string[] => [
    ...new Set([
      ...(extra ?? DEFAULT_FIELDS),
      ...customFields.map((f) => f.id),
      ...(options.sprintField ? [options.sprintField] : []),
    ]),
  ]

  const searchPage = (
    jql: string,
    opts: SearchOptions = {},
  ): Promise<JiraSearchPage> =>
    request<JiraSearchPage>("/rest/api/3/search/jql", {
      method: "POST",
      body: JSON.stringify({
        jql,
        fields: fieldList(opts.fields),
        maxResults: opts.maxResults ?? 50,
        ...(opts.nextPageToken ? { nextPageToken: opts.nextPageToken } : {}),
        ...(opts.expand ? { expand: opts.expand } : {}),
      }),
    })

  /**
   * Walks the cursor to `limit` issues. Three separate stop conditions, because
   * the cursor is opaque and has been reported to loop: no token, an empty
   * page, or a token we have already followed. Trusting `isLast` alone would
   * page forever against an instance exhibiting that bug.
   */
  const searchIssues = async (
    jql: string,
    opts: SearchOptions & { limit?: number } = {},
  ): Promise<JiraIssue[]> => {
    const limit = opts.limit ?? 50
    const issues: JiraIssue[] = []
    const seenTokens = new Set<string>()
    let token = opts.nextPageToken

    while (issues.length < limit) {
      const page = await searchPage(jql, {
        ...opts,
        nextPageToken: token,
        maxResults: Math.min(100, limit - issues.length),
      })
      if (page.issues.length === 0) break
      issues.push(...page.issues)

      const next = page.nextPageToken
      if (!next || page.isLast || seenTokens.has(next)) break
      seenTokens.add(next)
      token = next
    }

    return issues.slice(0, limit)
  }

  return {
    request,
    customFields,
    sprintField: options.sprintField,

    searchPage,
    searchIssues,

    getIssue: (key: string): Promise<JiraIssue> =>
      request(
        `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${fieldList([
          ...DEFAULT_FIELDS,
          "description",
          "comment",
          "reporter",
          "created",
          "attachment",
        ]).join(",")}`,
      ),

    getTransitions: (key: string): Promise<{ transitions: JiraTransition[] }> =>
      request(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`),

    transitionIssue: (key: string, transitionId: string): Promise<void> =>
      request(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
        method: "POST",
        body: JSON.stringify({ transition: { id: transitionId } }),
      }),

    addComment: (key: string, body: unknown): Promise<void> =>
      request(`/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
        method: "POST",
        body: JSON.stringify({ body }),
      }),

    getMe: (): Promise<JiraUser> => request("/rest/api/3/myself"),

    getFields: (): Promise<JiraField[]> => request("/rest/api/3/field"),

    getProjects: (): Promise<JiraProject[]> =>
      request("/rest/api/3/project?expand=description"),

    getBoards: (): Promise<{ values: JiraBoard[] }> =>
      request("/rest/agile/1.0/board"),

    getSprints: (
      boardId: number,
      state?: string,
    ): Promise<{ values: JiraSprint[] }> =>
      request(
        `/rest/agile/1.0/board/${boardId}/sprint${state ? `?state=${state}` : ""}`,
      ),

    // ── issues ────────────────────────────────────────────────────────────
    createIssue: (fields: Record<string, unknown>): Promise<JiraCreated> =>
      request("/rest/api/3/issue", {
        method: "POST",
        body: JSON.stringify({ fields }),
      }),

    updateIssue: (
      key: string,
      fields: Record<string, unknown>,
    ): Promise<void> =>
      request(`/rest/api/3/issue/${encodeURIComponent(key)}`, {
        method: "PUT",
        body: JSON.stringify({ fields }),
      }),

    deleteIssue: (key: string, deleteSubtasks = false): Promise<void> =>
      request(
        `/rest/api/3/issue/${encodeURIComponent(key)}?deleteSubtasks=${deleteSubtasks}`,
        { method: "DELETE" },
      ),

    assignIssue: (key: string, accountId: string | null): Promise<void> =>
      request(`/rest/api/3/issue/${encodeURIComponent(key)}/assignee`, {
        method: "PUT",
        body: JSON.stringify({ accountId }),
      }),

    getComments: (key: string): Promise<{ comments: JiraComment[] }> =>
      request(`/rest/api/3/issue/${encodeURIComponent(key)}/comment`),

    deleteComment: (key: string, commentId: string): Promise<void> =>
      request(
        `/rest/api/3/issue/${encodeURIComponent(key)}/comment/${encodeURIComponent(commentId)}`,
        { method: "DELETE" },
      ),

    getWatchers: (key: string): Promise<{ watchers: JiraUser[] }> =>
      request(`/rest/api/3/issue/${encodeURIComponent(key)}/watchers`),

    addWatcher: (key: string, accountId: string): Promise<void> =>
      request(`/rest/api/3/issue/${encodeURIComponent(key)}/watchers`, {
        method: "POST",
        body: JSON.stringify(accountId),
      }),

    removeWatcher: (key: string, accountId: string): Promise<void> =>
      request(
        `/rest/api/3/issue/${encodeURIComponent(key)}/watchers?accountId=${encodeURIComponent(accountId)}`,
        { method: "DELETE" },
      ),

    getWorklogs: (key: string): Promise<{ worklogs: JiraWorklog[] }> =>
      request(`/rest/api/3/issue/${encodeURIComponent(key)}/worklog`),

    addWorklog: (
      key: string,
      body: { timeSpent: string; comment?: unknown; started?: string },
    ): Promise<JiraWorklog> =>
      request(`/rest/api/3/issue/${encodeURIComponent(key)}/worklog`, {
        method: "POST",
        body: JSON.stringify(body),
      }),

    getChangelog: (key: string): Promise<{ values: JiraChangelogEntry[] }> =>
      request(`/rest/api/3/issue/${encodeURIComponent(key)}/changelog`),

    getIssueLinkTypes: (): Promise<{ issueLinkTypes: JiraIssueLinkType[] }> =>
      request("/rest/api/3/issueLinkType"),

    linkIssues: (
      type: string,
      inwardKey: string,
      outwardKey: string,
    ): Promise<void> =>
      request("/rest/api/3/issueLink", {
        method: "POST",
        body: JSON.stringify({
          type: { name: type },
          inwardIssue: { key: inwardKey },
          outwardIssue: { key: outwardKey },
        }),
      }),

    // ── projects ──────────────────────────────────────────────────────────
    getProject: (key: string): Promise<JiraProject> =>
      request(
        `/rest/api/3/project/${encodeURIComponent(key)}?expand=description,lead,url`,
      ),

    getProjectVersions: (key: string): Promise<JiraVersion[]> =>
      request(`/rest/api/3/project/${encodeURIComponent(key)}/versions`),

    getProjectComponents: (key: string): Promise<JiraComponent[]> =>
      request(`/rest/api/3/project/${encodeURIComponent(key)}/components`),

    getProjectStatuses: (key: string): Promise<JiraProjectStatuses[]> =>
      request(`/rest/api/3/project/${encodeURIComponent(key)}/statuses`),

    // ── agile ─────────────────────────────────────────────────────────────
    getBoard: (id: number): Promise<JiraBoard> =>
      request(`/rest/agile/1.0/board/${id}`),

    getBoardIssues: (
      id: number,
      jql?: string,
    ): Promise<{ issues: JiraIssue[] }> =>
      request(
        `/rest/agile/1.0/board/${id}/issue${jql ? `?jql=${encodeURIComponent(jql)}` : ""}`,
      ),

    getBacklog: (id: number): Promise<{ issues: JiraIssue[] }> =>
      request(`/rest/agile/1.0/board/${id}/backlog`),

    getSprint: (id: number): Promise<JiraSprint> =>
      request(`/rest/agile/1.0/sprint/${id}`),

    getSprintIssues: (id: number): Promise<{ issues: JiraIssue[] }> =>
      request(`/rest/agile/1.0/sprint/${id}/issue`),

    getBoardEpics: (id: number): Promise<{ values: JiraEpic[] }> =>
      request(`/rest/agile/1.0/board/${id}/epic`),

    getEpicIssues: (id: string): Promise<{ issues: JiraIssue[] }> =>
      request(`/rest/agile/1.0/epic/${encodeURIComponent(id)}/issue`),

    // ── people ────────────────────────────────────────────────────────────
    searchUsers: (query: string, maxResults = 20): Promise<JiraUser[]> =>
      request(
        `/rest/api/3/user/search?query=${encodeURIComponent(query)}&maxResults=${maxResults}`,
      ),

    searchAssignableUsers: (
      query: string,
      projectKey: string,
      maxResults = 20,
    ): Promise<JiraUser[]> =>
      request(
        `/rest/api/3/user/assignable/search?query=${encodeURIComponent(query)}&project=${encodeURIComponent(projectKey)}&maxResults=${maxResults}`,
      ),

    // ── instance metadata ─────────────────────────────────────────────────
    getIssueTypes: (): Promise<JiraIssueType[]> =>
      request("/rest/api/3/issuetype"),

    getPriorities: (): Promise<JiraNamed[]> => request("/rest/api/3/priority"),

    getResolutions: (): Promise<JiraNamed[]> =>
      request("/rest/api/3/resolution"),

    getStatuses: (): Promise<JiraNamed[]> => request("/rest/api/3/status"),

    getLabels: (): Promise<{ values: string[] }> =>
      request("/rest/api/3/label?maxResults=1000"),

    getFilters: (): Promise<{ values: JiraFilter[] }> =>
      request("/rest/api/3/filter/search?expand=jql&maxResults=50"),

    getDashboards: (): Promise<{ dashboards: JiraNamed[] }> =>
      request("/rest/api/3/dashboard"),

    getServerInfo: (): Promise<Record<string, unknown>> =>
      request("/rest/api/3/serverInfo"),

    getMyPermissions: (projectKey?: string): Promise<Record<string, unknown>> =>
      request(
        `/rest/api/3/mypermissions${projectKey ? `?projectKey=${encodeURIComponent(projectKey)}` : ""}`,
      ),

    /**
     * The count the removed `total` field used to give. Deliberately named
     * approximate because that is what Atlassian guarantees — it is an index
     * estimate, not a scan, and will disagree with a full page walk.
     */
    approximateCount: (jql: string): Promise<{ count: number }> =>
      request("/rest/api/3/search/approximate-count", {
        method: "POST",
        body: JSON.stringify({ jql }),
      }),
  }
}

export type JiraClient = ReturnType<typeof createJiraClient>
