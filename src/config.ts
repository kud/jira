import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { normalizeBaseUrl } from "./client.js"

export type CustomFieldRef = { id: string; label: string }

export type FileConfig = {
  baseUrl?: string
  email?: string
  customFields?: CustomFieldRef[]
  sprintField?: string
  defaultProject?: string
  defaultBoard?: number
  /**
   * Hand-written board tabs, each naming the statuses it claims by id or by
   * name. The escape hatch over a board's own column config — for an instance
   * with no board, or a board whose columns are not how you think.
   */
  tabs?: BoardTab[]
}

export type BoardTab = { label: string; statuses: string[] }

export type Config = FileConfig & {
  baseUrl: string
  email: string
  token: string
}

export const configPath = (): string =>
  process.env["JIRA_CONFIG_FILE"] ||
  join(
    process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config"),
    "jira",
    "config.json",
  )

/**
 * Credentials come from the environment and never from the config file: the
 * file is meant to be readable, diffable and shareable across a team, and a
 * token in it would leak the moment anyone pasted theirs into a gist.
 */
export const readFileConfig = (path = configPath()): FileConfig => {
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    return {}
  }
  const parsed = JSON.parse(raw) as FileConfig
  if (parsed.customFields && !Array.isArray(parsed.customFields))
    throw new Error(`${path}: customFields must be an array of {id,label}`)
  if ("token" in parsed || "apiToken" in parsed)
    throw new Error(
      `${path} contains a token. Tokens belong in ATLASSIAN_API_TOKEN, not in a file that gets shared and backed up — remove it.`,
    )
  return parsed
}

/**
 * Only the token is a secret, so only the token is env-only. The instance URL
 * and your email are settings, and asking someone to export three variables to
 * run a CLI is friction that buys nothing. Environment still wins where both
 * are present, so a second instance needs one inline override rather than a
 * second config file.
 */
export const loadConfig = (
  env: NodeJS.ProcessEnv = process.env,
  path = configPath(),
): { config: Config } | { missing: string[] } => {
  const file = readFileConfig(path)

  const baseUrl = env["ATLASSIAN_BASE_URL"] || file.baseUrl
  const email = env["ATLASSIAN_USER_EMAIL"] || file.email
  const token = env["ATLASSIAN_API_TOKEN"]

  const missing = (
    [
      ["ATLASSIAN_BASE_URL", baseUrl],
      ["ATLASSIAN_USER_EMAIL", email],
      ["ATLASSIAN_API_TOKEN", token],
    ] as const
  )
    .filter(([, v]) => !v)
    .map(([k]) => k)

  if (missing.length > 0) return { missing }

  return {
    config: {
      ...file,
      baseUrl: normalizeBaseUrl(baseUrl as string),
      email: email as string,
      token: token as string,
    },
  }
}
