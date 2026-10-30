import { readFile } from "node:fs/promises"
import { basename } from "node:path"
import type {
  JiraBoard,
  JiraBoardConfiguration,
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
  JiraRemoteLink,
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
import type { JiraAttachment } from "./attachments.js"

type RankResult = {
  entries?: Array<{ issueKey?: string; status: number; errors?: string[] }>
}

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

/**
 * Jira's own words for what went wrong — `errorMessages[]` from the body —
 * which is what a person can act on. `message` is the URL-prefixed, truncated
 * envelope and is the fallback, never the first choice.
 */
export const errorMessagesOf = (e: unknown): string[] => {
  if (isJiraApiError(e)) {
    try {
      const body = JSON.parse(e.body) as {
        errorMessages?: string[]
        errors?: Record<string, string>
      }
      const fromBody = [
        ...(body.errorMessages ?? []),
        ...Object.values(body.errors ?? {}),
      ]
      if (fromBody.length) return fromBody
    } catch {
      // not JSON — the envelope will do
    }
  }
  return [e instanceof Error ? e.message : String(e)]
}

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
  "parent",
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
        // A FormData body must not carry a static Content-Type: fetch sets the
        // multipart one with the boundary itself, and a JSON pin would break it.
        ...(init.body instanceof FormData
          ? {}
          : { "Content-Type": "application/json" }),
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
    // Any 2xx may have an empty body (e.g. 201 from POST /issueLink).
    // Read as text first; return undefined for empty, otherwise parse JSON.
    const text = await res.text()
    if (!text) return undefined as T
    return JSON.parse(text) as T
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
          "issuelinks",
          "subtasks",
        ]).join(",")}`,
      ),

    getTransitions: (key: string): Promise<{ transitions: JiraTransition[] }> =>
      request(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`),

    // `fields` rides along with the transition rather than going through a
    // separate edit: Jira rejects a resolution set on an already-closed issue, so
    // the only moment a screen-required field like `resolution` can be written is
    // the transition itself.
    transitionIssue: (
      key: string,
      transitionId: string,
      fields?: Record<string, unknown>,
    ): Promise<void> =>
      request(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
        method: "POST",
        body: JSON.stringify({
          transition: { id: transitionId },
          ...(fields ? { fields } : {}),
        }),
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

    updateComment: (
      key: string,
      commentId: string,
      body: unknown,
    ): Promise<JiraComment> =>
      request(
        `/rest/api/3/issue/${encodeURIComponent(key)}/comment/${encodeURIComponent(commentId)}`,
        { method: "PUT", body: JSON.stringify({ body }) },
      ),

    uploadAttachment: async (
      key: string,
      file: string | { data: Buffer | Uint8Array | Blob; filename: string },
    ): Promise<JiraAttachment[]> => {
      let data: Blob
      let filename: string
      if (typeof file === "string") {
        // `readFile`'s Buffer is a valid BlobPart at runtime; the cast exists
        // only for the ArrayBufferLike/ArrayBuffer split in lib types.
        data = new Blob([(await readFile(file)) as BlobPart])
        filename = basename(file)
      } else {
        data =
          file.data instanceof Blob
            ? file.data
            : new Blob([file.data as BlobPart])
        filename = file.filename
      }
      const form = new FormData()
      form.append("file", data, filename)
      return request(
        `/rest/api/3/issue/${encodeURIComponent(key)}/attachments`,
        {
          method: "POST",
          body: form,
          headers: { "X-Atlassian-Token": "no-check" },
        },
      )
    },

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

    updateWorklog: (
      key: string,
      worklogId: string,
      body: { timeSpent?: string; comment?: unknown; started?: string },
    ): Promise<JiraWorklog> =>
      request(
        `/rest/api/3/issue/${encodeURIComponent(key)}/worklog/${encodeURIComponent(worklogId)}`,
        { method: "PUT", body: JSON.stringify(body) },
      ),

    deleteWorklog: (key: string, worklogId: string): Promise<void> =>
      request(
        `/rest/api/3/issue/${encodeURIComponent(key)}/worklog/${encodeURIComponent(worklogId)}`,
        { method: "DELETE" },
      ),

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

    getRemoteLinks: (key: string): Promise<JiraRemoteLink[]> =>
      request(`/rest/api/3/issue/${encodeURIComponent(key)}/remotelink`),

    createRemoteLink: (
      key: string,
      link: {
        url: string
        title: string
        summary?: string
        globalId?: string
        relationship?: string
      },
    ): Promise<{ id: number; self: string }> =>
      request(`/rest/api/3/issue/${encodeURIComponent(key)}/remotelink`, {
        method: "POST",
        body: JSON.stringify({
          object: {
            url: link.url,
            title: link.title,
            ...(link.summary !== undefined ? { summary: link.summary } : {}),
          },
          ...(link.globalId !== undefined ? { globalId: link.globalId } : {}),
          ...(link.relationship !== undefined
            ? { relationship: link.relationship }
            : {}),
        }),
      }),

    deleteRemoteLink: (key: string, linkId: number | string): Promise<void> =>
      request(
        `/rest/api/3/issue/${encodeURIComponent(key)}/remotelink/${encodeURIComponent(String(linkId))}`,
        { method: "DELETE" },
      ),

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

    /** The board's columns and which statuses each one claims, by id. */
    getBoardConfiguration: (id: number): Promise<JiraBoardConfiguration> =>
      request(`/rest/agile/1.0/board/${id}/configuration`),

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

    moveIssuesToSprint: (
      sprintId: number,
      issueKeys: string[],
    ): Promise<void> =>
      request(`/rest/agile/1.0/sprint/${sprintId}/issue`, {
        method: "POST",
        body: JSON.stringify({ issues: issueKeys }),
      }),

    moveIssuesToBacklog: (issueKeys: string[]): Promise<void> =>
      request("/rest/agile/1.0/backlog/issue", {
        method: "POST",
        body: JSON.stringify({ issues: issueKeys }),
      }),

    // A 207 means some issues ranked and some did not. To the caller that is a
    // failure, so it throws naming each issue Jira refused and why.
    rankIssues: async (
      issueKeys: string[],
      position: { before: string } | { after: string },
    ): Promise<void> => {
      const result = await request<RankResult | undefined>(
        "/rest/agile/1.0/issue/rank",
        {
          method: "PUT",
          body: JSON.stringify({
            issues: issueKeys,
            ...("before" in position
              ? { rankBeforeIssue: position.before }
              : { rankAfterIssue: position.after }),
          }),
        },
      )
      const refused = (result?.entries ?? []).filter((e) => e.status >= 400)
      if (refused.length > 0) {
        const reasons = refused.map(
          (e) => `${e.issueKey ?? "?"}: ${e.errors?.join("; ") || e.status}`,
        )
        throw new Error(`Jira refused to rank ${reasons.join(", ")}`)
      }
    },

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

export type FlattenedIssueLink = {
  direction: "inward" | "outward"
  type: string
  key: string
  summary: string
  status: string
}

/**
 * Flattens an issue's issuelinks into a simpler array.
 * Each link becomes one entry with the human-readable type label
 * (inward for inwardIssue, outward for outwardIssue).
 */
export const flattenIssueLinks = (issue: JiraIssue): FlattenedIssueLink[] => {
  const links = issue.fields.issuelinks
  if (!links || links.length === 0) return []

  const result: FlattenedIssueLink[] = []
  for (const link of links) {
    if (link.inwardIssue) {
      result.push({
        direction: "inward",
        type: link.type.inward,
        key: link.inwardIssue.key,
        summary: link.inwardIssue.fields.summary,
        status: link.inwardIssue.fields.status?.name ?? "Unknown",
      })
    }
    if (link.outwardIssue) {
      result.push({
        direction: "outward",
        type: link.type.outward,
        key: link.outwardIssue.key,
        summary: link.outwardIssue.fields.summary,
        status: link.outwardIssue.fields.status?.name ?? "Unknown",
      })
    }
  }
  return result
}
