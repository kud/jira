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
