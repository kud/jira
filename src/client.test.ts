import { describe, expect, it } from "vitest"
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
