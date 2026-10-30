# Changelog

All notable changes to this project are documented here.

---

## 0.6.0 — 2026-10-30

### Highlights

- `getIssue` now returns an issue's `issuelinks` and `subtasks`, typed with the new `JiraIssueLink`, `JiraLinkedIssue` and `JiraSubtask`. Search results are unchanged. ([b1c30e4](https://github.com/kud/jira/commit/b1c30e4e37cc761cba3e7ef193f96e3df90cad3e))
- `flattenIssueLinks(issue)` turns those links into plain `{ direction, type, key, summary, status }` entries, so consumers stop unpicking inward and outward sides themselves. ([b1c30e4](https://github.com/kud/jira/commit/b1c30e4e37cc761cba3e7ef193f96e3df90cad3e))

### Fixes

- Any successful response with an empty body now resolves instead of throwing "Unexpected end of JSON input"; `linkIssues` was reporting failure on a successful 201. ([b1c30e4](https://github.com/kud/jira/commit/b1c30e4e37cc761cba3e7ef193f96e3df90cad3e))

---

## 0.5.0 — 2026-10-27

### Highlights

- The client can now edit and remove what it previously could only create: `updateComment`, `updateWorklog` and `deleteWorklog`. ([d1b0923](https://github.com/kud/jira/commit/d1b0923c90d18242f64db0e2601188bbeb2e1cfe))
- `uploadAttachment` attaches files to an issue, and `getRemoteLinks`, `createRemoteLink` and `deleteRemoteLink` manage its remote links, typed with the new `JiraRemoteLink`. ([d1b0923](https://github.com/kud/jira/commit/d1b0923c90d18242f64db0e2601188bbeb2e1cfe))
- Sprint planning is covered: `moveIssuesToSprint`, `moveIssuesToBacklog` and `rankIssues`. `rankIssues` throws naming each issue Jira refused when it answers 207 with partial failures. ([d1b0923](https://github.com/kud/jira/commit/d1b0923c90d18242f64db0e2601188bbeb2e1cfe))

---

## 0.4.0 — 2026-09-14

### Highlights

- `getBoardConfiguration(id)` returns a board's columns alongside the status ids each one claims, so a consumer can render a board without hand-mapping statuses to columns itself. ([62bda08](https://github.com/kud/jira/commit/62bda08e59d25e18bd70c67f89d83ad6d7f12052))
- `JiraIssueType` gains a `hierarchyLevel` and now types `issuetype` everywhere it appears — worth knowing if you build `issuetype` objects by hand, since the type is `JiraIssueType` (`id` + `name` + optional fields) rather than the old `{ name }`. `isContainerType(type)` is the one way to ask whether a type heads children (Epic, Initiative, and the like), instead of every consumer inventing its own check against `hierarchyLevel`.
- `errorMessagesOf(e)` pulls the actionable text straight out of Jira's own error shape — `errorMessages[]` or `errors{}` — so callers don't have to parse the API's inconsistent error responses by hand.
- The JQL helpers move down from `jira-cli` into the shared library: `jqlEscape`, `buildJql`, `looksLikeJql`, `textClause` and `searchJql` are now available to any consumer, not just the CLI.
- File configuration gains a `tabs` field, for defining custom board tabs.

---

## 0.3.0 — 2026-09-11

### Highlights

- Credential resolution moved down into the core, so any host built on `@kud/jira` — a TUI, a cockpit extension — can resolve an instance's URL, email and token the same way `@kud/jira-cli` does, and hand the result straight to `createJiraClient` instead of re-implementing the lookup. The new `loadConfig`, `readFileConfig` and `configPath` exports (with the `Config`, `FileConfig` and `CustomFieldRef` types) resolve `ATLASSIAN_BASE_URL` and `ATLASSIAN_USER_EMAIL` from the environment or `$XDG_CONFIG_HOME/jira/config.json`, while `ATLASSIAN_API_TOKEN` stays environment-only — a token found in the config file is treated as an error. A failed lookup returns every missing variable at once rather than stopping at the first. ([1289668](https://github.com/kud/jira/commit/128966868d839b88dc4ed546941f1ba657f0fbb3))

---
