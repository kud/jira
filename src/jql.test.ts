import { describe, expect, it } from "vitest"
import { buildJql, looksLikeJql, searchJql, textClause } from "./jql.js"

describe("looksLikeJql", () => {
  it("recognises the clause shape, not just an operator somewhere", () => {
    expect(looksLikeJql("status = Done")).toBe(true)
    expect(looksLikeJql('project = "ACME" AND labels in (a, b)')).toBe(true)
    expect(looksLikeJql("assignee in (currentUser())")).toBe(true)
    expect(looksLikeJql("NOT status = Done")).toBe(true)
    expect(looksLikeJql("(status = Done)")).toBe(true)
    expect(looksLikeJql("summary ~ coupon")).toBe(true)
    expect(looksLikeJql("ORDER BY created DESC")).toBe(true)
  })

  it("leaves natural phrases alone", () => {
    expect(looksLikeJql("in progress")).toBe(false)
    expect(looksLikeJql("coupon whitespace")).toBe(false)
    expect(looksLikeJql("what is the total")).toBe(false)
    expect(looksLikeJql("SHOP-412")).toBe(false)
    expect(looksLikeJql("he was here")).toBe(false)
    expect(looksLikeJql("status was \"Done\"")).toBe(true)
    expect(looksLikeJql("status changed after -7d")).toBe(true)
    expect(looksLikeJql("assignee is EMPTY")).toBe(true)
  })
})

describe("searchJql", () => {
  it("scopes plain words inside the list and reads comments too", () => {
    expect(searchJql("coupon codes", { scope: "assignee = currentUser()" })).toEqual({
      jql: 'assignee = currentUser() AND text ~ "coupon codes" ORDER BY updated DESC',
      mode: "text",
    })
  })

  it("passes JQL through verbatim, replacing the scope", () => {
    expect(searchJql("status = Done", { scope: "assignee = currentUser()" })).toEqual({
      jql: "status = Done",
      mode: "jql",
    })
  })

  it("honours a forced mode either way", () => {
    expect(searchJql("status = broken", { mode: "text" }).mode).toBe("text")
    expect(searchJql("in progress", { mode: "jql" }).mode).toBe("jql")
  })

  it("escapes what Lucene would otherwise read as syntax", () => {
    expect(textClause("c++ (beta)")).toBe('text ~ "c\\+\\+ \\(beta\\)"')
    expect(textClause('say "hi"')).toBe('text ~ "say \\"hi\\""')
  })
})

describe("buildJql", () => {
  it("defaults an empty flag set to the viewer's own issues", () => {
    expect(buildJql({})).toBe("assignee = currentUser() ORDER BY updated DESC")
  })

  it("lets --jql replace everything", () => {
    expect(buildJql({ jql: "project = X", mine: true })).toBe("project = X")
  })
})
