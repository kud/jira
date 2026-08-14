import type { JiraClient } from "./client.js"
import type { JiraIssue } from "./types.js"

export type JiraAttachment = {
  id: string
  filename: string
  mimeType: string
  size: number
  created?: string
  author?: { displayName: string }
  content?: string
}

/** Where an attachment was referenced from, so `issue view` can say so. */
export type AttachmentOrigin =
  | { kind: "issue" }
  | { kind: "description" }
  | { kind: "comment"; commentId: string; author?: string }

export type LocatedAttachment = JiraAttachment & { origins: AttachmentOrigin[] }

type AdfNode = {
  type?: string
  attrs?: Record<string, unknown>
  content?: AdfNode[]
}

export type MediaRef = { id?: string; filename?: string }

/**
 * Media nodes carry a media-platform UUID in `attrs.id`, which is a different
 * namespace from the numeric attachment id — joining on it matches nothing,
 * ever. `attrs.alt` holds the original filename and is the only field the two
 * representations share, so it is the real key and the id is the fallback.
 */
const mediaRefs = (node: unknown): MediaRef[] => {
  if (!node || typeof node !== "object") return []
  const n = node as AdfNode
  const here: MediaRef[] =
    n.type === "media"
      ? [
          {
            ...(typeof n.attrs?.["id"] === "string"
              ? { id: n.attrs["id"] as string }
              : {}),
            ...(typeof n.attrs?.["alt"] === "string"
              ? { filename: n.attrs["alt"] as string }
              : {}),
          },
        ]
      : []
  return [...here, ...(n.content ?? []).flatMap(mediaRefs)]
}

/**
 * Jira reports attachments once, on the issue, and never says where they were
 * embedded. Walking the description and each comment for media nodes and
 * joining them back is the only way to answer "which comment did this come
 * from" — a question the API cannot be asked directly.
 */
export const locateAttachments = (issue: JiraIssue): LocatedAttachment[] => {
  const attachments = (issue.fields["attachment"] as JiraAttachment[]) ?? []
  const origins = new Map<string, AttachmentOrigin[]>()

  const note = (ref: MediaRef, origin: AttachmentOrigin): void => {
    const match = attachments.find(
      (a) =>
        (ref.filename !== undefined && a.filename === ref.filename) ||
        (ref.id !== undefined && a.id === ref.id),
    )
    if (!match) return
    origins.set(match.id, [...(origins.get(match.id) ?? []), origin])
  }

  for (const ref of mediaRefs(issue.fields.description))
    note(ref, { kind: "description" })

  for (const comment of issue.fields.comment?.comments ?? [])
    for (const ref of mediaRefs(comment.body))
      note(ref, {
        kind: "comment",
        commentId: comment.id,
        author: comment.author?.displayName,
      })

  return attachments.map((a) => ({
    ...a,
    origins: origins.get(a.id) ?? [{ kind: "issue" as const }],
  }))
}

const TEXTUAL =
  /^(text\/|application\/(json|xml|x-yaml|yaml|javascript|sql|x-sh))/

/** Extensions Jira commonly mislabels as application/octet-stream. */
const TEXTUAL_EXTENSIONS =
  /\.(txt|md|markdown|log|json|ya?ml|csv|tsv|xml|html?|css|jsx?|tsx?|py|rb|go|rs|java|kt|sh|zsh|bash|sql|ini|toml|conf|env|diff|patch)$/i

export const isTextual = (attachment: JiraAttachment): boolean =>
  TEXTUAL.test(attachment.mimeType) ||
  TEXTUAL_EXTENSIONS.test(attachment.filename)

/**
 * Fetches attachment bytes. The documented content endpoint 302s to a
 * short-lived media host, and the auth header must NOT follow: it is a Jira
 * credential and the redirect target is a different origin that neither needs
 * nor should see it. Hence manual redirect handling rather than fetch's default.
 */
export const downloadAttachment = async (
  client: JiraClient,
  id: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<{ bytes: Uint8Array; mimeType: string | null }> => {
  const res = await client.request<Response>(
    `/rest/api/3/attachment/content/${encodeURIComponent(id)}`,
    { redirect: "manual", raw: true },
  )

  const location = res.headers.get("location")
  const final =
    res.status >= 300 && res.status < 400 && location
      ? await fetchImpl(location)
      : res

  if (!final.ok) {
    throw new Error(
      `could not download attachment ${id}: ${final.status} ${final.statusText}`,
    )
  }

  return {
    bytes: new Uint8Array(await final.arrayBuffer()),
    mimeType: final.headers.get("content-type"),
  }
}
