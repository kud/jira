# Changelog

All notable changes to this project are documented here.

---

## 0.3.0 — 2026-09-11

### Highlights

- Credential resolution moved down into the core, so any host built on `@kud/jira` — a TUI, a cockpit extension — can resolve an instance's URL, email and token the same way `@kud/jira-cli` does, and hand the result straight to `createJiraClient` instead of re-implementing the lookup. The new `loadConfig`, `readFileConfig` and `configPath` exports (with the `Config`, `FileConfig` and `CustomFieldRef` types) resolve `ATLASSIAN_BASE_URL` and `ATLASSIAN_USER_EMAIL` from the environment or `$XDG_CONFIG_HOME/jira/config.json`, while `ATLASSIAN_API_TOKEN` stays environment-only — a token found in the config file is treated as an error. A failed lookup returns every missing variable at once rather than stopping at the first. ([1289668](https://github.com/kud/jira/commit/128966868d839b88dc4ed546941f1ba657f0fbb3))

---
