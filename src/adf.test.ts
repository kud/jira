import { describe, expect, it } from "vitest"
import { adfToMarkdown, markdownToAdf } from "./adf.js"

describe("mentions", () => {
  it("does not double the @ Jira already stores", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "mention", attrs: { text: "@Ada", id: "1" } }],
        },
      ],
    }

    expect(adfToMarkdown(doc)).toBe("@Ada")
  })

  it("adds one when the stored text lacks it", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "mention", attrs: { text: "Ada", id: "1" } }],
        },
      ],
    }

    expect(adfToMarkdown(doc)).toBe("@Ada")
  })
})

describe("markdownToAdf", () => {
  it("splits blank-line-separated blocks into paragraphs", () => {
    const doc = markdownToAdf("one\n\ntwo")

    expect(doc.content).toHaveLength(2)
    expect(doc).toMatchObject({ type: "doc", version: 1 })
  })

  it("keeps a fenced code block intact, language and all", () => {
    const [block] = markdownToAdf("```ts\nconst a = 1\n```").content as [
      Record<string, unknown>,
    ]

    expect(block).toMatchObject({
      type: "codeBlock",
      attrs: { language: "ts" },
      content: [{ type: "text", text: "const a = 1" }],
    })
  })

  it("turns a dash list into a bulletList", () => {
    const [block] = markdownToAdf("- one\n- two").content as [
      { type: string; content: unknown[] },
    ]

    expect(block.type).toBe("bulletList")
    expect(block.content).toHaveLength(2)
  })

  it("marks code spans and links inside a paragraph", () => {
    const [block] = markdownToAdf("run `npm ci` see [docs](https://x.test)")
      .content as [{ content: { text: string; marks?: { type: string }[] }[] }]

    expect(block.content.find((n) => n.text === "npm ci")?.marks).toEqual([
      { type: "code" },
    ])
    expect(block.content.find((n) => n.text === "docs")?.marks?.[0]?.type).toBe(
      "link",
    )
  })

  it("survives a round trip through the renderer", () => {
    expect(adfToMarkdown(markdownToAdf("# Title\n\nsome text"))).toBe(
      "# Title\n\nsome text",
    )
  })
})

type Task = {
  type: string
  attrs: { localId: string; state: string }
  content: { type: string; text: string; marks?: { type: string }[] }[]
}
type TaskList = { type: string; attrs: { localId: string }; content: Task[] }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe("markdownToAdf task lists", () => {
  it("turns checkbox items into one taskList of taskItems", () => {
    const [list] = markdownToAdf(
      "- [ ] water the ferns\n- [x] feed the cat\n- [X] fold the laundry",
    ).content as [TaskList]

    expect(list.type).toBe("taskList")
    expect(list.content.map((t) => t.type)).toEqual([
      "taskItem",
      "taskItem",
      "taskItem",
    ])
    expect(list.content.map((t) => t.attrs.state)).toEqual([
      "TODO",
      "DONE",
      "DONE",
    ])
    expect(list.content[0]?.content).toEqual([
      { type: "text", text: "water the ferns" },
    ])
  })

  it("gives the list and every item its own UUID localId", () => {
    const [list] = markdownToAdf("- [ ] one\n- [ ] two").content as [TaskList]
    const ids = [
      list.attrs.localId,
      ...list.content.map((t) => t.attrs.localId),
    ]

    ids.forEach((id) => expect(id).toMatch(UUID))
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("splits a mixed list into taskList and bulletList runs", () => {
    const blocks = markdownToAdf(
      "- [ ] buy flour\n- [x] buy eggs\n- remember the bag\n- [ ] bake",
    ).content as { type: string; content: unknown[] }[]

    expect(blocks.map((b) => [b.type, b.content.length])).toEqual([
      ["taskList", 2],
      ["bulletList", 1],
      ["taskList", 1],
    ])
  })

  it("keeps code spans and links inside a task", () => {
    const [list] = markdownToAdf(
      "- [ ] run `make tidy` then read [the guide](https://example.test/guide)",
    ).content as [TaskList]
    const content = list.content[0]?.content ?? []

    expect(content.find((n) => n.text === "make tidy")?.marks).toEqual([
      { type: "code" },
    ])
    expect(content.find((n) => n.text === "the guide")?.marks?.[0]?.type).toBe(
      "link",
    )
  })

  it("leaves an empty checkbox item with no content rather than empty text", () => {
    const [list] = markdownToAdf("- [ ]").content as [TaskList]

    expect(list.content[0]?.content).toEqual([])
  })

  it("leaves a bracket pair that does not open the item as text", () => {
    const [list] = markdownToAdf("- tick [ ] when done").content as [
      {
        type: string
        content: { content: { content: { text: string }[] }[] }[]
      },
    ]
    const [para] = markdownToAdf("[ ] is just text here").content as [
      { type: string; content: { text: string }[] },
    ]

    expect(list.type).toBe("bulletList")
    expect(list.content[0]?.content[0]?.content[0]?.text).toBe(
      "tick [ ] when done",
    )
    expect(para.type).toBe("paragraph")
    expect(para.content[0]?.text).toBe("[ ] is just text here")
  })

  it("survives a round trip through the renderer", () => {
    const markdown = "- [ ] water the ferns\n- [x] feed the cat\n- bring snacks"

    expect(adfToMarkdown(markdownToAdf(markdown))).toBe(
      "- [ ] water the ferns\n- [x] feed the cat\n\n- bring snacks",
    )
  })
})

describe("adfToMarkdown task lists", () => {
  it("renders nested task lists indented under their parent", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "taskList",
          attrs: { localId: "a" },
          content: [
            {
              type: "taskItem",
              attrs: { localId: "b", state: "TODO" },
              content: [{ type: "text", text: "pack" }],
            },
            {
              type: "taskList",
              attrs: { localId: "c" },
              content: [
                {
                  type: "taskItem",
                  attrs: { localId: "d", state: "DONE" },
                  content: [{ type: "text", text: "socks" }],
                },
              ],
            },
          ],
        },
      ],
    }

    expect(adfToMarkdown(doc)).toBe("- [ ] pack\n  - [x] socks")
  })
})

type Text = {
  type: string
  text: string
  marks?: { type: string; attrs?: { href?: string } }[]
}
type Block = {
  type: string
  attrs?: Record<string, unknown>
  content: Text[]
}

const SITE = "https://acme.example.net"
const para = (markdown: string, baseUrl?: string): Text[] =>
  (markdownToAdf(markdown, { baseUrl }).content as [Block])[0].content
const hrefOf = (nodes: Text[], text: string): string | undefined =>
  nodes.find((n) => n.text === text)?.marks?.find((m) => m.type === "link")
    ?.attrs?.href

describe("markdownToAdf code", () => {
  it("gives a fenced block its language", () => {
    const [block] = markdownToAdf("```ts\nconst a = 1\n```").content as [Block]

    expect(block).toEqual({
      type: "codeBlock",
      attrs: { language: "ts" },
      content: [{ type: "text", text: "const a = 1" }],
    })
  })

  it("leaves attrs off a fence with no language", () => {
    const [block] = markdownToAdf("```\nplain\n```").content as [Block]

    expect(block.type).toBe("codeBlock")
    expect(block.attrs).toBeUndefined()
  })

  it("keeps a fence whole across blank lines, prose either side", () => {
    const blocks = markdownToAdf(
      "before\n\n```py\nfirst()\n\nsecond()\n```\n\nafter",
    ).content as Block[]

    expect(blocks.map((b) => b.type)).toEqual([
      "paragraph",
      "codeBlock",
      "paragraph",
    ])
    expect(blocks[1]?.content[0]?.text).toBe("first()\n\nsecond()")
  })

  it("keeps a checkbox, bold and a link inside a fence literal", () => {
    const code = "- [ ] not a task\n**not bold** SHOP-1 https://example.test"
    const [block] = markdownToAdf("```md\n" + code + "\n```", { baseUrl: SITE })
      .content as [Block]

    expect(block.type).toBe("codeBlock")
    expect(block.content).toEqual([{ type: "text", text: code }])
  })

  it("marks inline backticks as code and parses nothing inside them", () => {
    const nodes = para("use `**raw** SHOP-1 https://x.test` here", SITE)

    expect(nodes).toEqual([
      { type: "text", text: "use " },
      {
        type: "text",
        text: "**raw** SHOP-1 https://x.test",
        marks: [{ type: "code" }],
      },
      { type: "text", text: " here" },
    ])
  })

  it("puts inline code inside a task item", () => {
    const [list] = markdownToAdf("- [ ] run `npm ci` first").content as [
      { content: { content: Text[] }[] },
    ]

    expect(list.content[0]?.content).toEqual([
      { type: "text", text: "run " },
      { type: "text", text: "npm ci", marks: [{ type: "code" }] },
      { type: "text", text: " first" },
    ])
  })
})

describe("markdownToAdf bold", () => {
  it("turns **x** into the strong mark", () => {
    expect(para("a **bold** move")).toEqual([
      { type: "text", text: "a " },
      { type: "text", text: "bold", marks: [{ type: "strong" }] },
      { type: "text", text: " move" },
    ])
  })

  it("keeps a code span inside bold as code alone", () => {
    const nodes = para("**see `cfg` now**")

    expect(nodes.find((n) => n.text === "cfg")?.marks).toEqual([
      { type: "code" },
    ])
    expect(nodes.find((n) => n.text === "see ")?.marks).toEqual([
      { type: "strong" },
    ])
  })

  it("bolds text inside a task item", () => {
    const [list] = markdownToAdf("- [x] **ship** it").content as [
      { content: { content: Text[] }[] },
    ]

    expect(list.content[0]?.content[0]).toEqual({
      type: "text",
      text: "ship",
      marks: [{ type: "strong" }],
    })
  })
})

describe("markdownToAdf links", () => {
  it("links a [label](url)", () => {
    expect(
      hrefOf(para("read [the notes](https://example.test/n)"), "the notes"),
    ).toBe("https://example.test/n")
  })

  it("links a bare URL, leaving trailing punctuation outside", () => {
    const nodes = para("see https://example.test/a?b=1.")

    expect(hrefOf(nodes, "https://example.test/a?b=1")).toBe(
      "https://example.test/a?b=1",
    )
    expect(nodes.at(-1)).toEqual({ type: "text", text: "." })
  })

  it("links owner/repo#N to the GitHub issue, keeping the text", () => {
    expect(
      hrefOf(para("fixed in acme/widgets#42 today"), "acme/widgets#42"),
    ).toBe("https://github.com/acme/widgets/issues/42")
  })

  it("links a bare issue key to the configured site", () => {
    expect(hrefOf(para("blocks SHOP-123, sadly", `${SITE}/`), "SHOP-123")).toBe(
      `${SITE}/browse/SHOP-123`,
    )
  })

  it("leaves issue keys as text when no site is configured", () => {
    expect(para("blocks SHOP-123")).toEqual([
      { type: "text", text: "blocks SHOP-123" },
    ])
  })

  it.each([
    "UTF-8",
    "ISO-8601",
    "SHA-256",
    "RFC-9110",
    "TLS-1",
    "HTTP-2",
    "CVE-2031-4242",
  ])("does not link the standard %s", (standard) => {
    const nodes = para(`encoded as ${standard} here`, SITE)

    expect(nodes.some((n) => n.marks?.length)).toBe(false)
    expect(nodes.map((n) => n.text).join("")).toBe(
      `encoded as ${standard} here`,
    )
  })

  it("does not link a key inside a URL or an existing link", () => {
    const nodes = para(
      "open https://tracker.example.test/SHOP-9 or [SHOP-8](https://example.test/x)",
      SITE,
    )

    expect(hrefOf(nodes, "https://tracker.example.test/SHOP-9")).toBe(
      "https://tracker.example.test/SHOP-9",
    )
    expect(hrefOf(nodes, "SHOP-8")).toBe("https://example.test/x")
    expect(nodes.filter((n) => n.marks)).toHaveLength(2)
  })

  it("does not read a path segment as a GitHub ref", () => {
    const nodes = para("see docs/guide/setup#3 for details")

    expect(nodes.some((n) => n.marks)).toBe(false)
  })
})
