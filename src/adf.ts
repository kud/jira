import { randomUUID } from "node:crypto"

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
    case "taskList":
      return (node.content ?? [])
        .map((item) =>
          item.type === "taskList"
            ? render(item)
                .split("\n")
                .map((l) => `  ${l}`)
                .join("\n")
            : `- [${item.attrs?.["state"] === "DONE" ? "x" : " "}] ${children(item)}`.trimEnd(),
        )
        .join("\n")
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
export const adfToMarkdown = (doc: unknown, media?: MediaResolver): string => {
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

type Mark = { type: string; attrs?: Record<string, unknown> }
type TextNode = { type: "text"; text: string; marks?: Mark[] }

export type MarkdownToAdfOptions = {
  /** The Jira site, e.g. `https://acme.atlassian.net`; bare issue keys link to it. Without it they stay text. */
  baseUrl?: string
}

let site: string | undefined

/**
 * Prefixes that read like issue keys but are standards and versions. A real
 * project could use one of these keys, but `UTF-8` in prose is far likelier.
 */
const NOT_ISSUE_KEYS = new Set([
  "AES",
  "ANSI",
  "BASE",
  "CRC",
  "CVE",
  "CWE",
  "DDR",
  "ECMA",
  "EN",
  "ES",
  "FIPS",
  "GHSA",
  "GMT",
  "HTTP",
  "HTTPS",
  "IEC",
  "IEEE",
  "IPV",
  "ISO",
  "MD",
  "NIST",
  "PCI",
  "PEP",
  "RFC",
  "RSA",
  "SHA",
  "SOC",
  "SSL",
  "TLS",
  "USB",
  "UTC",
  "UTF",
  "WCAG",
  "WPA",
])

const INLINE = new RegExp(
  [
    /`([^`]+)`/.source,
    /\[([^\]]+)\]\(([^)\s]+)\)/.source,
    /\*\*(?=\S)([\s\S]+?)\*\*/.source,
    /(https?:\/\/[^\s<>()[\]`]+)/.source,
    /(?<![\w/.#-])([A-Za-z0-9][\w.-]*\/[\w.-]+#\d+)(?!\w)/.source,
    /(?<![\w/.#-])([A-Z][A-Z0-9]+)-(\d+)(?![\w-])/.source,
  ].join("|"),
  "g",
)

const link = (text: string, href: string): TextNode => ({
  type: "text",
  text,
  marks: [{ type: "link", attrs: { href } }],
})

/**
 * Inline Markdown to ADF text nodes. Nothing inside a code span is parsed
 * further, and a URL or a `[label](href)` swallows any key or ref in it, so
 * neither is linked twice.
 */
const inline = (text: string): TextNode[] => {
  const nodes: TextNode[] = []
  const plain = (s: string): void => {
    if (!s) return
    const last = nodes.at(-1)
    if (last && !last.marks) last.text += s
    else nodes.push({ type: "text", text: s })
  }
  let cursor = 0

  for (const m of text.matchAll(INLINE)) {
    const at = m.index
    let end = at + m[0].length
    const [, code, label, href, strong, url, ref, project, number] = m

    if (at < cursor) continue
    plain(text.slice(cursor, at))

    if (code !== undefined) {
      nodes.push({ type: "text", text: code, marks: [{ type: "code" }] })
    } else if (label !== undefined && href !== undefined) {
      nodes.push(link(label, href))
    } else if (strong !== undefined) {
      // ADF lets `code` share a node with `link` only, so a code span inside
      // bold stays code rather than gaining a mark Jira would reject.
      for (const node of inline(strong)) {
        const isCode = node.marks?.some((mk) => mk.type === "code")
        nodes.push(
          isCode
            ? node
            : { ...node, marks: [...(node.marks ?? []), { type: "strong" }] },
        )
      }
    } else if (url !== undefined) {
      const trimmed = url.replace(/[.,;:!?'"]+$/, "")
      end = at + trimmed.length
      nodes.push(link(trimmed, trimmed))
    } else if (ref !== undefined) {
      const [repo = "", issue = ""] = ref.split("#")
      nodes.push(link(ref, `https://github.com/${repo}/issues/${issue}`))
    } else if (project !== undefined && number !== undefined) {
      const key = `${project}-${number}`
      if (site && !NOT_ISSUE_KEYS.has(project))
        nodes.push(link(key, `${site}/browse/${key}`))
      else plain(key)
    }
    cursor = end
  }

  plain(text.slice(cursor))
  return nodes
}

const BULLET = /^\s*[-*]\s+/
const TASK = /^\s*[-*]\s+\[([ xX])\](?:\s+(.*))?$/

const taskItem = (line: string): unknown => {
  const [, mark = " ", text = ""] = line.match(TASK) ?? []
  return {
    type: "taskItem",
    attrs: { localId: randomUUID(), state: mark === " " ? "TODO" : "DONE" },
    content: inline(text),
  }
}

const bulletItem = (line: string): unknown => ({
  type: "listItem",
  content: [{ type: "paragraph", content: inline(line.replace(BULLET, "")) }],
})

/**
 * A dash list, split into runs: consecutive `- [ ]`/`- [x]` lines become one
 * taskList, the plain bullets between them stay a bulletList. Jira has no list
 * that holds both, so a mixed list comes out as alternating siblings.
 */
const bulletRuns = (lines: string[]): unknown[] => {
  const runs: { task: boolean; lines: string[] }[] = []
  for (const line of lines) {
    const task = TASK.test(line)
    const last = runs.at(-1)
    if (last?.task === task) last.lines.push(line)
    else runs.push({ task, lines: [line] })
  }
  return runs.map((run) =>
    run.task
      ? {
          type: "taskList",
          attrs: { localId: randomUUID() },
          content: run.lines.map(taskItem),
        }
      : { type: "bulletList", content: run.lines.map(bulletItem) },
  )
}

const blockToAdf = (block: string): unknown | unknown[] => {
  const heading = block.match(/^(#{1,6})\s+(.*)$/)
  if (heading)
    return {
      type: "heading",
      attrs: { level: heading[1]?.length ?? 1 },
      content: inline(heading[2] ?? ""),
    }

  const lines = block.split("\n")
  if (lines.every((l) => BULLET.test(l))) return bulletRuns(lines)

  if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l)))
    return {
      type: "orderedList",
      content: lines.map((l) => ({
        type: "listItem",
        content: [
          {
            type: "paragraph",
            content: inline(l.replace(/^\s*\d+[.)]\s+/, "")),
          },
        ],
      })),
    }

  return { type: "paragraph", content: inline(block) }
}

const codeBlock = (language: string, code: string): unknown => ({
  type: "codeBlock",
  ...(language ? { attrs: { language } } : {}),
  // ADF text nodes must not be empty, so an empty fence carries no content.
  content: code ? [{ type: "text", text: code }] : [],
})

/**
 * Fenced blocks are cut out first, whole, so a blank line inside one does not
 * split it and nothing inside one is read as a list, a task or a mark.
 */
const blocks = (text: string): unknown[] => {
  const out: unknown[] = []
  const prose: string[] = []
  const flush = (): void => {
    out.push(
      ...prose
        .join("\n")
        .split(/\n{2,}/)
        .map((b) => b.trim())
        .filter(Boolean)
        .flatMap(blockToAdf),
    )
    prose.length = 0
  }

  const lines = text.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i]?.match(/^\s*```\s*([\w+#.-]*)\s*$/)
    if (!open) {
      prose.push(lines[i] ?? "")
      continue
    }
    const close = lines.findIndex((l, j) => j > i && /^\s*```\s*$/.test(l))
    const last = close === -1 ? lines.length : close
    flush()
    out.push(codeBlock(open[1] ?? "", lines.slice(i + 1, last).join("\n")))
    i = last
  }
  flush()
  return out
}

/**
 * Markdown to ADF, covering what someone actually types into a comment from a
 * terminal: paragraphs, fenced code, headings, lists and task lists, bold,
 * code spans, links, bare URLs, `owner/repo#N` refs and, given the site, bare
 * issue keys. Deliberately partial — anything richer is better authored in
 * Jira, and a half-supported table would corrupt more often than it would help.
 */
export const markdownToAdf = (
  text: string,
  options: MarkdownToAdfOptions = {},
): AdfDoc => {
  const previous = site
  site = options.baseUrl?.replace(/\/+$/, "")
  try {
    return {
      type: "doc",
      version: 1,
      content: blocks(text.replace(/\r\n/g, "\n")),
    }
  } finally {
    site = previous
  }
}
