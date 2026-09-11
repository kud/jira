import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { loadConfig, readFileConfig } from "./config.js"

const env = {
  ATLASSIAN_BASE_URL: "example.atlassian.net",
  ATLASSIAN_USER_EMAIL: "someone@example.com",
  ATLASSIAN_API_TOKEN: "token",
}

let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jira-config-"))
  path = join(dir, "config.json")
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("loadConfig", () => {
  it("names every missing variable at once, not just the first", () => {
    const result = loadConfig({ ATLASSIAN_BASE_URL: "x" }, path)

    expect(result).toEqual({
      missing: ["ATLASSIAN_USER_EMAIL", "ATLASSIAN_API_TOKEN"],
    })
  })

  it("normalises a bare host so browse urls are clickable", () => {
    const result = loadConfig(env, path)

    expect("config" in result && result.config.baseUrl).toBe(
      "https://example.atlassian.net",
    )
  })

  it("works with no config file at all", () => {
    const result = loadConfig(env, join(dir, "absent.json"))

    expect("config" in result && result.config.customFields).toBeUndefined()
  })

  it("layers the file's custom fields under the environment's credentials", () => {
    writeFileSync(
      path,
      JSON.stringify({
        customFields: [{ id: "customfield_10002", label: "points" }],
        sprintField: "customfield_10020",
      }),
    )

    const result = loadConfig(env, path)

    expect("config" in result && result.config.customFields).toEqual([
      { id: "customfield_10002", label: "points" },
    ])
  })

  it("takes baseUrl and email from the file when the environment is silent", () => {
    writeFileSync(
      path,
      JSON.stringify({
        baseUrl: "fromfile.atlassian.net",
        email: "file@example.com",
      }),
    )

    const result = loadConfig({ ATLASSIAN_API_TOKEN: "token" }, path)

    expect("config" in result && result.config.baseUrl).toBe(
      "https://fromfile.atlassian.net",
    )
    expect("config" in result && result.config.email).toBe("file@example.com")
  })

  it("lets the environment override the file, for a second instance", () => {
    writeFileSync(path, JSON.stringify({ baseUrl: "fromfile.atlassian.net" }))

    const result = loadConfig(env, path)

    expect("config" in result && result.config.baseUrl).toBe(
      "https://example.atlassian.net",
    )
  })

  it("still requires the token from the environment", () => {
    writeFileSync(
      path,
      JSON.stringify({ baseUrl: "x.atlassian.net", email: "a@b.test" }),
    )

    expect(loadConfig({}, path)).toEqual({ missing: ["ATLASSIAN_API_TOKEN"] })
  })
})

describe("readFileConfig", () => {
  it("rejects a malformed customFields rather than silently ignoring it", () => {
    writeFileSync(path, JSON.stringify({ customFields: "customfield_10002" }))

    expect(() => readFileConfig(path)).toThrow(/customFields must be an array/)
  })

  it("refuses a token on disk instead of quietly ignoring it", () => {
    writeFileSync(path, JSON.stringify({ token: "sneaky" }))

    expect(() => readFileConfig(path)).toThrow(/Tokens belong in/)
  })
})
