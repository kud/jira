export type JiraUser = {
  accountId: string
  displayName: string
  emailAddress?: string
  active?: boolean
}

export type JiraStatus = {
  name: string
  statusCategory?: { key: string; name: string }
}

export type JiraIssueFields = {
  summary?: string
  status?: JiraStatus
  assignee?: JiraUser | null
  reporter?: JiraUser | null
  issuetype?: { name: string }
  priority?: { name: string } | null
  project?: { key: string; name: string }
  labels?: string[]
  created?: string
  updated?: string
  description?: unknown
  comment?: { comments: JiraComment[] }
  [field: string]: unknown
}

export type JiraIssue = {
  id: string
  key: string
  self: string
  fields: JiraIssueFields
}

export type JiraComment = {
  id: string
  author?: JiraUser
  created?: string
  body?: unknown
}

export type JiraTransition = {
  id: string
  name: string
  to?: JiraStatus
}

export type JiraBoard = { id: number; name: string; type?: string }

export type JiraSprint = {
  id: number
  name: string
  state: string
  startDate?: string
  endDate?: string
}

export type JiraProject = { id: string; key: string; name: string }

export type JiraField = {
  id: string
  name: string
  custom: boolean
  schema?: { type?: string; custom?: string }
}

/**
 * A page of the enhanced JQL search. `total` and `startAt` are deliberately
 * absent: /rest/api/3/search/jql replaced offset paging with an opaque cursor
 * and stopped reporting a count at all.
 */
export type JiraSearchPage = {
  issues: JiraIssue[]
  nextPageToken?: string
  isLast?: boolean
}

export type SearchOptions = {
  fields?: string[]
  maxResults?: number
  nextPageToken?: string
  expand?: string
}

export type JiraCreated = { id: string; key: string; self: string }

export type JiraNamed = { id: string; name: string; description?: string }

export type JiraIssueType = JiraNamed & { subtask?: boolean; scope?: unknown }

export type JiraVersion = JiraNamed & {
  released?: boolean
  archived?: boolean
  releaseDate?: string
}

export type JiraComponent = JiraNamed & { lead?: JiraUser }

export type JiraProjectStatuses = {
  id: string
  name: string
  statuses: JiraNamed[]
}

export type JiraEpic = {
  id: number
  key: string
  name: string
  summary?: string
  done?: boolean
}

export type JiraFilter = {
  id: string
  name: string
  jql?: string
  owner?: JiraUser
}

export type JiraWorklog = {
  id: string
  author?: JiraUser
  timeSpent?: string
  timeSpentSeconds?: number
  started?: string
  comment?: unknown
}

export type JiraIssueLinkType = {
  id: string
  name: string
  inward: string
  outward: string
}

export type JiraChangelogEntry = {
  id: string
  author?: JiraUser
  created?: string
  items?: {
    field: string
    fromString?: string | null
    toString?: string | null
  }[]
}
