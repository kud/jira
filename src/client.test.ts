import { describe, expect, it } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createJiraClient, isJiraApiError, normalizeBaseUrl } from "./client.js"
import type { JiraSearchPage } from "./types.js"

const credentials = {
  baseUrl: "https://example.atlassian.net",
  email: "someone@example.com",
  token: "token",
}

const issue = (key: string) => ({
  id: key,
  key,
  self: "",
  fields: { summary: key },
})

/** A fetch that replays the given pages in order and records every request. */
const fakeSearch = (pages: JiraSearchPage[]) => {
  const bodies: Record<string, unknown>[] = []
  let call = 0
  const fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)))
    const page = pages[call++] ?? { issues: [] }
    return new Response(JSON.stringify(page), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as unknown as typeof globalThis.fetch
  return { fetch, bodies, calls: () => call }
}

describe("normalizeBaseUrl", () => {
  it("accepts a bare host, which is how the env var is usually written", () => {
    expect(normalizeBaseUrl("myorg.atlassian.net")).toBe(
      "https://myorg.atlassian.net",
    )
  })

  it("leaves an explicit scheme alone and trims trailing slashes", () => {
    expect(normalizeBaseUrl("http://localhost:8080/")).toBe(
      "http://localhost:8080",
    )
  })
})

describe("searchIssues pagination", () => {
  it("follows nextPageToken until the cursor runs out", async () => {
    const fake = fakeSearch([
      { issues: [issue("A-1")], nextPageToken: "t1" },
      { issues: [issue("A-2")], nextPageToken: "t2" },
      { issues: [issue("A-3")] },
    ])
    const client = createJiraClient({ ...credentials, fetch: fake.fetch })

    const issues = await client.searchIssues("project = A", { limit: 10 })

    expect(issues.map((i) => i.key)).toEqual(["A-1", "A-2", "A-3"])
    expect(fake.bodies[1]?.["nextPageToken"]).toBe("t1")
  })

  it("stops when the cursor repeats, rather than paging forever", async () => {
    // Jira has been reported to hand back a token that returns the same page;
    // trusting the token alone would loop until the process is killed.
    const fake = fakeSearch([
      { issues: [issue("A-1")], nextPageToken: "same" },
      { issues: [issue("A-2")], nextPageToken: "same" },
      { issues: [issue("A-3")], nextPageToken: "same" },
    ])
    const client = createJiraClient({ ...credentials, fetch: fake.fetch })

    const issues = await client.searchIssues("project = A", { limit: 100 })

    expect(issues.map((i) => i.key)).toEqual(["A-1", "A-2"])
    expect(fake.calls()).toBe(2)
  })

  it("stops on an empty page even when a token is offered", async () => {
    const fake = fakeSearch([
      { issues: [issue("A-1")], nextPageToken: "t1" },
      { issues: [], nextPageToken: "t2" },
    ])
    const client = createJiraClient({ ...credentials, fetch: fake.fetch })

    expect(
      (await client.searchIssues("project = A", { limit: 100 })).map(
        (i) => i.key,
      ),
    ).toEqual(["A-1"])
  })

  it("honours isLast", async () => {
    const fake = fakeSearch([
      { issues: [issue("A-1")], nextPageToken: "t1", isLast: true },
      { issues: [issue("A-2")] },
    ])
    const client = createJiraClient({ ...credentials, fetch: fake.fetch })

    expect(
      await client.searchIssues("project = A", { limit: 100 }),
    ).toHaveLength(1)
  })

  it("never returns more than the requested limit", async () => {
    const fake = fakeSearch([
      { issues: [issue("A-1"), issue("A-2"), issue("A-3")] },
    ])
    const client = createJiraClient({ ...credentials, fetch: fake.fetch })

    expect(await client.searchIssues("project = A", { limit: 2 })).toHaveLength(
      2,
    )
  })
})

describe("field selection", () => {
  it("always sends an explicit fields array, which the endpoint requires", async () => {
    const fake = fakeSearch([{ issues: [] }])
    const client = createJiraClient({ ...credentials, fetch: fake.fetch })

    await client.searchIssues("project = A")

    expect(fake.bodies[0]?.["fields"]).toEqual(
      expect.arrayContaining(["summary"]),
    )
  })

  it("asks for parent, so a caller can name the epic an issue hangs under", async () => {
    const fake = fakeSearch([{ issues: [] }])
    const client = createJiraClient({ ...credentials, fetch: fake.fetch })

    await client.searchIssues("project = A")

    expect(fake.bodies[0]?.["fields"]).toEqual(
      expect.arrayContaining(["parent"]),
    )
  })

  it("includes the instance's configured custom and sprint fields", async () => {
    const fake = fakeSearch([{ issues: [] }])
    const client = createJiraClient({
      ...credentials,
      fetch: fake.fetch,
      customFields: [{ id: "customfield_10002", label: "points" }],
      sprintField: "customfield_10020",
    })

    await client.searchIssues("project = A")

    const fields = fake.bodies[0]?.["fields"] as string[]
    expect(fields).toContain("customfield_10002")
    expect(fields).toContain("customfield_10020")
  })

  it("does not repeat a custom field already asked for", async () => {
    const fake = fakeSearch([{ issues: [] }])
    const client = createJiraClient({
      ...credentials,
      fetch: fake.fetch,
      customFields: [{ id: "summary", label: "summary" }],
    })

    await client.searchIssues("project = A")

    const fields = fake.bodies[0]?.["fields"] as string[]
    expect(fields.filter((f) => f === "summary")).toHaveLength(1)
  })
})

describe("errors", () => {
  it("carries the status so the caller can separate auth from everything else", async () => {
    const fetch = (async () =>
      new Response("nope", {
        status: 401,
      })) as unknown as typeof globalThis.fetch
    const client = createJiraClient({ ...credentials, fetch })

    const error = await client.getMe().catch((e: unknown) => e)

    expect(isJiraApiError(error)).toBe(true)
    expect(isJiraApiError(error) && error.status).toBe(401)
  })

  it("asks for English error bodies, which Jira otherwise localises", async () => {
    let headers: Headers | undefined
    const fetch = (async (_url: string, init: RequestInit) => {
      headers = new Headers(init.headers)
      return new Response("{}", { status: 200 })
    }) as unknown as typeof globalThis.fetch

    await createJiraClient({ ...credentials, fetch }).getMe()

    expect(headers?.get("accept-language")).toBe("en")
  })
})

describe("errorMessagesOf", () => {
  it("prefers Jira's own words from the body", async () => {
    const { errorMessagesOf, jiraApiError } = await import("./client.js")
    const e = jiraApiError(
      400,
      "POST",
      "https://example.atlassian.net/rest/api/3/search/jql",
      JSON.stringify({
        errorMessages: ["Field 'statsu' does not exist."],
        errors: { jql: "Expecting an operator." },
      }),
    )
    expect(errorMessagesOf(e)).toEqual([
      "Field 'statsu' does not exist.",
      "Expecting an operator.",
    ])
  })

  it("falls back to the envelope when the body is not JSON", async () => {
    const { errorMessagesOf, jiraApiError } = await import("./client.js")
    const e = jiraApiError(
      502,
      "GET",
      "https://example.atlassian.net/x",
      "<html>",
    )
    expect(errorMessagesOf(e)[0]).toMatch(/^Jira API 502/)
    expect(errorMessagesOf(new Error("plain"))).toEqual(["plain"])
  })
})

describe("isContainerType", () => {
  it("trusts hierarchyLevel when present and the name otherwise", async () => {
    const { isContainerType } = await import("./types.js")
    expect(
      isContainerType({ id: "1", name: "Initiative", hierarchyLevel: 2 }),
    ).toBe(true)
    expect(isContainerType({ id: "2", name: "Epic", hierarchyLevel: 1 })).toBe(
      true,
    )
    expect(isContainerType({ id: "3", name: "Epic", hierarchyLevel: 0 })).toBe(
      false,
    )
    expect(isContainerType({ id: "4", name: "Epic" })).toBe(true)
    expect(isContainerType({ id: "5", name: "Story" })).toBe(false)
    expect(isContainerType(undefined)).toBe(false)
  })
})

/** A fetch that records a single request and replays a JSON success. */
const fakeCall = (payload: unknown = {}) => {
  // Prefilled so tests can read it without a non-null assert; tests only read
  // after the client has fired its request.
  let call = {
    url: "",
    method: "",
    headers: new Headers(),
    body: null as RequestInit["body"],
  }
  const fetch = (async (url: string, init: RequestInit) => {
    call = {
      url: String(url),
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      body: init.body ?? null,
    }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as unknown as typeof globalThis.fetch
  return { fetch, request: () => call }
}

describe("issue writes", () => {
  it("moveIssuesToSprint posts the issue list to the sprint", async () => {
    const fake = fakeCall({})
    const client = createJiraClient({ ...credentials, fetch: fake.fetch })

    await client.moveIssuesToSprint(42, ["SHOP-1234", "SHOP-5678"])

    const req = fake.request()
    expect(req.method).toBe("POST")
    expect(req.url).toBe(
      "https://example.atlassian.net/rest/agile/1.0/sprint/42/issue",
    )
    expect(JSON.parse(String(req.body))).toEqual({
      issues: ["SHOP-1234", "SHOP-5678"],
    })
  })

  it("moveIssuesToBacklog posts the issue list to the backlog", async () => {
    const fake = fakeCall({})
    const client = createJiraClient({ ...credentials, fetch: fake.fetch })

    await client.moveIssuesToBacklog(["SHOP-1234"])

    const req = fake.request()
    expect(req.method).toBe("POST")
    expect(req.url).toBe(
      "https://example.atlassian.net/rest/agile/1.0/backlog/issue",
    )
    expect(JSON.parse(String(req.body))).toEqual({ issues: ["SHOP-1234"] })
  })

  it("rankIssues sends rankBeforeIssue or rankAfterIssue, never both", async () => {
    const fake = fakeCall({})
    const client = createJiraClient({ ...credentials, fetch: fake.fetch })

    await client.rankIssues(["SHOP-1234"], { before: "SHOP-9999" })

    expect(fake.request().method).toBe("PUT")
    expect(fake.request().url).toBe(
      "https://example.atlassian.net/rest/agile/1.0/issue/rank",
    )
    expect(JSON.parse(String(fake.request().body))).toEqual({
      issues: ["SHOP-1234"],
      rankBeforeIssue: "SHOP-9999",
    })

    await client.rankIssues(["SHOP-1234"], { after: "SHOP-9999" })

    expect(JSON.parse(String(fake.request().body))).toEqual({
      issues: ["SHOP-1234"],
      rankAfterIssue: "SHOP-9999",
    })
  })

  it("rankIssues throws on a 207 naming each issue Jira refused", async () => {
    const fetch = (async () =>
      new Response(
        JSON.stringify({
          entries: [
            { issueKey: "SHOP-1234", status: 200 },
            { issueKey: "SHOP-1235", status: 403, errors: ["Not allowed"] },
          ],
        }),
        { status: 207 },
      )) as unknown as typeof globalThis.fetch
    const client = createJiraClient({ ...credentials, fetch })

    await expect(
      client.rankIssues(["SHOP-1234", "SHOP-1235"], { before: "SHOP-9999" }),
    ).rejects.toThrow("Jira refused to rank SHOP-1235: Not allowed")
  })

  it("updateComment PUTs the ADF body to the comment id", async () => {
    const fake = fakeCall({ id: "10001" })
    const client = createJiraClient({ ...credentials, fetch: fake.fetch })

    const adf = [
      [{ type: "paragraph", content: [{ type: "text", text: "now edited" }] }],
    ]
    await client.updateComment("SHOP-1234", "10001", adf)

    const req = fake.request()
    expect(req.method).toBe("PUT")
    expect(req.url).toBe(
      "https://example.atlassian.net/rest/api/3/issue/SHOP-1234/comment/10001",
    )
    expect(JSON.parse(String(req.body))).toEqual({ body: adf })
  })

  it("uploadAttachment posts FormData with X-Atlassian-Token and no JSON Content-Type", async () => {
    const fake = fakeCall([{ id: "10000" }])
    const client = createJiraClient({ ...credentials, fetch: fake.fetch })

    await client.uploadAttachment("SHOP-1234", {
      data: new Uint8Array([104, 105]),
      filename: "notes.txt",
    })

    const req = fake.request()
    expect(req.method).toBe("POST")
    expect(req.url).toBe(
      "https://example.atlassian.net/rest/api/3/issue/SHOP-1234/attachments",
    )
    expect(req.headers.get("x-atlassian-token")).toBe("no-check")
    expect(req.headers.get("content-type")).toBeNull()
    const form = req.body
    expect(form).toBeInstanceOf(FormData)
    const entry = (form as FormData).get("file")
    expect(entry).toBeInstanceOf(File)
    expect((entry as File).name).toBe("notes.txt")
  })

  it("uploadAttachment reads a file path and names the field after its basename", async () => {
    const fake = fakeCall([{ id: "10000" }])
    const client = createJiraClient({ ...credentials, fetch: fake.fetch })
    const dir = await mkdtemp(join(tmpdir(), "jira-upload-"))
    const file = join(dir, "notes.txt")
    await writeFile(file, "hello")
    try {
      await client.uploadAttachment("SHOP-1234", file)

      const entry = (fake.request().body as FormData).get("file")
      expect(entry).toBeInstanceOf(File)
      expect((entry as File).name).toBe("notes.txt")
      expect((entry as File).size).toBe(5)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("a JSON method still sends Content-Type application/json", async () => {
    const fake = fakeCall({ id: "10001" })
    const client = createJiraClient({ ...credentials, fetch: fake.fetch })

    await client.addComment("SHOP-1234", {
      type: "paragraph",
      content: [{ type: "text", text: "hello" }],
    })

    expect(fake.request().headers.get("content-type")).toBe("application/json")
  })

  it("getRemoteLinks GETs the issue's remotelink list", async () => {
    const fake = fakeCall([{ id: 10023 }])
    const client = createJiraClient({ ...credentials, fetch: fake.fetch })

    const links = await client.getRemoteLinks("SHOP-1234")

    expect(links).toEqual([{ id: 10023 }])
    expect(fake.request().method).toBe("GET")
    expect(fake.request().url).toBe(
      "https://example.atlassian.net/rest/api/3/issue/SHOP-1234/remotelink",
    )
  })

  it("createRemoteLink omits the optional keys that were not given", async () => {
    const fake = fakeCall({
      id: 10023,
      self: "https://example.atlassian.net/x",
    })
    const client = createJiraClient({ ...credentials, fetch: fake.fetch })

    await client.createRemoteLink("SHOP-1234", {
      url: "https://example.com/page",
      title: "A page",
    })

    expect(JSON.parse(String(fake.request().body))).toEqual({
      object: { url: "https://example.com/page", title: "A page" },
    })

    await client.createRemoteLink("SHOP-1234", {
      url: "https://example.com/page",
      title: "A page",
      summary: "why it matters",
      globalId: "system:test",
      relationship: "causes",
    })

    expect(JSON.parse(String(fake.request().body))).toEqual({
      object: {
        url: "https://example.com/page",
        title: "A page",
        summary: "why it matters",
      },
      globalId: "system:test",
      relationship: "causes",
    })
  })

  it("deleteRemoteLink DELETEs the link by id", async () => {
    const fake = fakeCall({})
    const client = createJiraClient({ ...credentials, fetch: fake.fetch })

    await client.deleteRemoteLink("SHOP-1234", 10023)

    const req = fake.request()
    expect(req.method).toBe("DELETE")
    expect(req.url).toBe(
      "https://example.atlassian.net/rest/api/3/issue/SHOP-1234/remotelink/10023",
    )
  })

  it("updateWorklog PUTs the given fields to the worklog id", async () => {
    const fake = fakeCall({ id: "10001" })
    const client = createJiraClient({ ...credentials, fetch: fake.fetch })

    await client.updateWorklog("SHOP-1234", "10001", {
      timeSpent: "2h",
      comment: { type: "doc", version: 1 },
    })

    const req = fake.request()
    expect(req.method).toBe("PUT")
    expect(req.url).toBe(
      "https://example.atlassian.net/rest/api/3/issue/SHOP-1234/worklog/10001",
    )
    expect(JSON.parse(String(req.body))).toEqual({
      timeSpent: "2h",
      comment: { type: "doc", version: 1 },
    })
  })

  it("deleteWorklog DELETEs the worklog", async () => {
    const fake = fakeCall({})
    const client = createJiraClient({ ...credentials, fetch: fake.fetch })

    await client.deleteWorklog("SHOP-1234", "10001")

    const req = fake.request()
    expect(req.method).toBe("DELETE")
    expect(req.url).toBe(
      "https://example.atlassian.net/rest/api/3/issue/SHOP-1234/worklog/10001",
    )
  })
})
