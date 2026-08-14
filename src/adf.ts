type AdfNode = {
  type?: string
  text?: string
  content?: AdfNode[]
  attrs?: Record<string, unknown>
  marks?: { type: string; attrs?: Record<string, unknown> }[]
}

const markUp = (text: string, marks: AdfNode["marks"]): string =>
  (marks ?? []).reduce((acc, mark) => {
    if (mark.type === "code") return `\`${acc}\``
    if (mark.type === "strong") return `**${acc}**`
    if (mark.type === "em") return `_${acc}_`
    if (mark.type === "strike") return `~~${acc}~~`
    if (mark.type === "link") return `[${acc}](${mark.attrs?.["href"] ?? ""})`
    return acc
  }, text)

export type MediaResolver = (id: string) => string | undefined

let resolveMedia: MediaResolver = () => undefined

const children = (node: AdfNode, sep = ""): string =>
  (node.content ?? []).map(render).join(sep)

const listItems = (node: AdfNode, bullet: (i: number) => string): string =>
  (node.content ?? [])
    .map((item, i) => {
      const body = children(item, "\n\n").trim()
      const [first = "", ...rest] = body.split("\n")
      const marker = bullet(i)
      const indent = " ".repeat(marker.length)
      return [
        `${marker}${first}`,
        ...rest.map((l) => (l ? `${indent}${l}` : l)),
      ].join("\n")
    })
    .join("\n")

/** A table row rendered as a pipe row; the header separator is added by the caller. */
const row = (node: AdfNode): string =>
  `| ${(node.content ?? []).map((cell) => children(cell, " ").trim().replace(/\n+/g, " ")).join(" | ")} |`

const renderTable = (node: AdfNode): string => {
  const rows = node.content ?? []
  if (rows.length === 0) return ""
  const isHeader = (r: AdfNode): boolean =>
    (r.content ?? []).some((c) => c.type === "tableHeader")
  const [first] = rows
  const rendered = rows.map(row)
  if (first && isHeader(first)) {
    const columns = (first.content ?? []).length
    rendered.splice(1, 0, `|${" --- |".repeat(columns)}`)
  }
  return rendered.join("\n")
}

const render = (node: AdfNode): string => {
  switch (node.type) {
    case "doc":
      return children(node, "\n\n")
    case "paragraph":
      return children(node)
    case "text":
      return markUp(node.text ?? "", node.marks)
    case "hardBreak":
      return "\n"
    case "heading":
      return `${"#".repeat(Number(node.attrs?.["level"] ?? 1))} ${children(node)}`
    case "bulletList":
      return listItems(node, () => "- ")
    case "orderedList":
      return listItems(
        node,
        (i) => `${Number(node.attrs?.["order"] ?? 1) + i}. `,
      )
    case "codeBlock":
      return `\`\`\`${node.attrs?.["language"] ?? ""}\n${children(node)}\n\`\`\``
    case "blockquote":
      return children(node, "\n\n")
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n")
    case "panel":
      return `> [!${String(node.attrs?.["panelType"] ?? "note").toUpperCase()}]\n${children(
        node,
        "\n\n",
      )
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n")}`
    case "rule":
      return "---"
    case "table":
      return renderTable(node)
    case "mediaSingle":
    case "mediaGroup":
      return children(node, "\n")
    case "media": {
      // `alt` is the filename Jira stored; the id is a media-platform UUID that
      // means nothing to a reader and does not match the attachment id either.
      const alt = node.attrs?.["alt"]
      if (typeof alt === "string" && alt) return `[attachment: ${alt}]`
      const id = String(node.attrs?.["id"] ?? "")
      const name = resolveMedia(id)
      return name ? `[attachment: ${name}]` : `[attachment: ${id || "unknown"}]`
    }
    case "mention": {
      // Jira stores the display text with its own leading @ most of the time,
      // but not always, so normalise rather than assume either way.
      const label = String(node.attrs?.["text"] ?? node.attrs?.["id"] ?? "")
      return label.startsWith("@") ? label : `@${label}`
    }
    case "emoji":
      return String(node.attrs?.["text"] ?? node.attrs?.["shortName"] ?? "")
    case "date":
      return String(node.attrs?.["timestamp"] ?? "")
    case "status":
      return `[${String(node.attrs?.["text"] ?? "").toUpperCase()}]`
    case "inlineCard":
      return String(node.attrs?.["url"] ?? "")
    default:
      return children(node, "\n\n")
  }
}

/**
 * Atlassian Document Format to Markdown. Deliberately stops at Markdown rather
 * than emitting ANSI: rendering is the surface's job, so a TUI, a pager and a
 * `--json` consumer all get the same text and only one of them styles it.
 */
export const adfToMarkdown = (
  doc: unknown,
  media?: MediaResolver,
): string => {
  if (typeof doc === "string") return doc
  if (!doc || typeof doc !== "object") return ""
  const previous = resolveMedia
  resolveMedia = media ?? (() => undefined)
  try {
    return render(doc as AdfNode)
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  } finally {
    resolveMedia = previous
  }
}

type AdfDoc = { type: "doc"; version: 1; content: unknown[] }

const inline = (text: string): unknown[] => {
  // Only code spans and links are worth parsing: they are the two marks whose
  // absence changes meaning rather than appearance.
  const pattern = /(`[^`]+`)|(\[[^\]]+\]\([^)]+\))/g
  const nodes: unknown[] = []
  let cursor = 0

  for (const match of text.matchAll(pattern)) {
    const at = match.index
    if (at > cursor)
      nodes.push({ type: "text", text: text.slice(cursor, at) })

    const token = match[0]
    if (token.startsWith("`")) {
      nodes.push({
        type: "text",
        text: token.slice(1, -1),
        marks: [{ type: "code" }],
      })
    } else {
      const [, label = "", href = ""] =
        token.match(/\[([^\]]+)\]\(([^)]+)\)/) ?? []
      nodes.push({
        type: "text",
        text: label,
        marks: [{ type: "link", attrs: { href } }],
      })
    }
    cursor = at + token.length
  }

  if (cursor < text.length) nodes.push({ type: "text", text: text.slice(cursor) })
  return nodes.length > 0 ? nodes : [{ type: "text", text }]
}

const blockToAdf = (block: string): unknown => {
  const fence = block.match(/^```(\w*)\n([\s\S]*?)\n?```$/)
  if (fence)
    return {
      type: "codeBlock",
      ...(fence[1] ? { attrs: { language: fence[1] } } : {}),
      content: [{ type: "text", text: fence[2] ?? "" }],
    }

  const heading = block.match(/^(#{1,6})\s+(.*)$/)
  if (heading)
    return {
      type: "heading",
      attrs: { level: heading[1]?.length ?? 1 },
      content: inline(heading[2] ?? ""),
    }

  const lines = block.split("\n")
  if (lines.every((l) => /^\s*[-*]\s+/.test(l)))
    return {
      type: "bulletList",
      content: lines.map((l) => ({
        type: "listItem",
        content: [
          { type: "paragraph", content: inline(l.replace(/^\s*[-*]\s+/, "")) },
        ],
      })),
    }

  if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l)))
    return {
      type: "orderedList",
      content: lines.map((l) => ({
        type: "listItem",
        content: [
          { type: "paragraph", content: inline(l.replace(/^\s*\d+[.)]\s+/, "")) },
        ],
      })),
    }

  return { type: "paragraph", content: inline(block) }
}

/**
 * Markdown to ADF, covering what someone actually types into a comment from a
 * terminal: paragraphs, fenced code, headings, lists, links and code spans.
 * Deliberately partial — anything richer is better authored in Jira, and a
 * half-supported table would corrupt more often than it would help.
 */
export const markdownToAdf = (text: string): AdfDoc => ({
  type: "doc",
  version: 1,
  content: text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean)
    .map(blockToAdf),
})
