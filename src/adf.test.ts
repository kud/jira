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
