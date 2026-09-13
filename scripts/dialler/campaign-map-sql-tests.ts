/**
 * Offline tests for the dialler campaign mapping SQL.
 *
 *   npx tsx scripts/dialler/campaign-map-sql-tests.ts
 *
 * No warehouse, no writes.
 *
 * Two things here are worth more than the rest. First, COLUMN RESOLUTION: both
 * source tables are ones this app has never read, so their id and name columns
 * are resolved at run time from an ordered candidate list — and "ordered"
 * carries real weight, because a table with both CAMPAIGNID and ID must pick
 * the former. Second, THE CARDINALITY: one SilverSurfer campaign to many Yaxxa
 * ones, enforced by keying the map on the Yaxxa id. An INSERT where the code
 * does a MERGE would quietly produce the two-parent state the whole design
 * exists to prevent, and nothing downstream would complain.
 */
import {
  MAP_TABLE,
  SS_SOURCE,
  YAXXA_SOURCE,
  buildAttach,
  buildCampaignCount,
  buildCampaigns,
  buildColumnProbe,
  buildDetach,
  buildDoubleBookedCheck,
  buildEnsureMapTable,
  buildMapView,
  buildMappingsFor,
  buildOwnerOf,
  buildStaleMappings,
  buildUnmappedCount,
  isResolved,
  resolveColumns,
} from "../../lib/dialler-campaign-map"

let failures = 0
function check(name: string, ok: boolean, detail = "") {
  if (ok) console.log(`  ok   ${name}`)
  else {
    failures++
    console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`)
  }
}

const SS_COLS = { id: "CAMPAIGNID", label: "TITLE", extras: [] }
const Y_COLS = { id: "CAMP_ID", label: "CAMP_NAME", extras: ["CAMP_STATUS", "CAMP_DESC"] }

console.log("resolveColumns — ordered, not any-match")
{
  // A table carrying both must pick the specific one; ID alone is ambiguous
  // in a warehouse where every table has one.
  const r = resolveColumns(SS_SOURCE, ["ID", "CAMPAIGNID", "TITLE", "DESCRIPTION"])
  check("prefers CAMPAIGNID over ID", r.id === "CAMPAIGNID", JSON.stringify(r))
  check("prefers TITLE over DESCRIPTION", r.label === "TITLE", JSON.stringify(r))
}
{
  const r = resolveColumns(SS_SOURCE, ["id", "title"])
  check("matching is case-insensitive", r.id === "ID" && r.label === "TITLE", JSON.stringify(r))
}
{
  // THE REAL COLUMNS. The first attempt guessed CAMPAIGN_ID/CAMPAIGN_NAME and
  // resolved neither; the screen said so, naming every candidate it tried.
  const r = resolveColumns(YAXXA_SOURCE, [
    "CAMP_ID", "CAMP_NAME", "CAMP_DESC", "CAMP_STATUS", "CAMP_TYPE", "TENANT_ID",
  ])
  check("resolves the Yaxxa side", r.id === "CAMP_ID" && r.label === "CAMP_NAME", JSON.stringify(r))
  check("and reports as resolved", isResolved(r))
  // Only the ones that exist — CAMP_DIALER is absent from this list and must
  // not be selected, or the query dies on an invalid identifier.
  check("picks up only the extras that exist",
    r.extras.join(",") === "CAMP_STATUS,CAMP_TYPE,CAMP_DESC", JSON.stringify(r.extras))
}
{
  // The old guesses stay as fallbacks, so a differently-shaped install still
  // resolves rather than failing outright.
  const r = resolveColumns(YAXXA_SOURCE, ["CAMPAIGN_ID", "CAMPAIGN_NAME"])
  check("the previous guesses remain as fallbacks",
    r.id === "CAMPAIGN_ID" && r.label === "CAMPAIGN_NAME", JSON.stringify(r))
  check("with no extras when the table has none", r.extras.length === 0)
}
{
  const r = resolveColumns(YAXXA_SOURCE, ["CAMP_ID", "CAMPAIGN_ID", "CAMP_NAME", "CAMPAIGN_NAME"])
  check("CAMP_ID wins over the older candidate", r.id === "CAMP_ID", JSON.stringify(r))
  check("CAMP_NAME wins over the older candidate", r.label === "CAMP_NAME", JSON.stringify(r))
}
{
  // A probe that comes back empty is a missing grant, not a missing table —
  // the route turns this into a message naming the grants script.
  const r = resolveColumns(YAXXA_SOURCE, [])
  check("nothing matched is null, not a guess", r.id === null && r.label === null)
  check("and is reported as unresolved", !isResolved(r))
}
{
  const r = resolveColumns(SS_SOURCE, ["CAMPAIGNID", "SOMETHING_ELSE"])
  check("a half match is still unresolved", !isResolved(r), JSON.stringify(r))
}

console.log("\nbuildColumnProbe")
{
  const sql = buildColumnProbe(YAXXA_SOURCE)
  check("reads INFORMATION_SCHEMA", sql.includes("INFORMATION_SCHEMA.COLUMNS"))
  check("scoped to the one table", sql.includes("'CAMPAIGN_MASTER'") && sql.includes("'YAXXA_DW_REPLICATION'"), sql)
  check("is read-only", !/\b(INSERT|UPDATE|DELETE|MERGE|CREATE)\b/i.test(sql))
}

console.log("\nbuildCampaigns")
{
  const sql = buildCampaigns(SS_SOURCE, SS_COLS, "", 25, 0)
  check("applies the active filter", sql.includes("ACTIVE = 1"), sql)
  check("casts the id so a numeric key still compares as text", sql.includes("CAST(CAMPAIGNID AS VARCHAR)"), sql)
  check("paginates", sql.includes("LIMIT 25 OFFSET 0"))
  check("orders by the readable column", sql.includes("ORDER BY TITLE"), sql)
}
{
  const sql = buildCampaigns(YAXXA_SOURCE, Y_COLS, "", 50, 0)
  // The dialler is multi-tenant. Without this the picker offers another
  // tenant's test campaigns — Internal, inbound_camp, auto_camp — and mapping
  // to one would be quietly wrong rather than an error.
  check("scopes to the tenant", sql.includes("TENANT_ID = 1002"), sql)
  // Asymmetric on purpose: only an explicit TRUE is excluded, so if the
  // replication flag does not mean what it looks like the failure is showing
  // too much rather than an empty picker nobody can explain.
  check("excludes only rows explicitly flagged deleted",
    sql.includes("IFNULL(_EDGE_DELETED, FALSE) = FALSE"), sql)
  // Y, X and N are unexplained, so the screen shows the status instead of
  // filtering on a meaning nobody has confirmed.
  check("does NOT filter on CAMP_STATUS", !/WHERE[\s\S]*CAMP_STATUS/.test(sql), sql)
  check("selects the extras it resolved",
    sql.includes("CAMP_STATUS AS EXTRA_0") && sql.includes("CAMP_DESC AS EXTRA_1"), sql)
}
{
  // A source with no extras must not emit a trailing comma into the SELECT.
  const sql = buildCampaigns(SS_SOURCE, SS_COLS, "", 25, 0)
  check("no extras means no stray comma", !sql.includes("LABEL,"), sql)
  check("and no EXTRA_ aliases at all", !sql.includes("EXTRA_"), sql)
}
{
  const sql = buildCampaigns(SS_SOURCE, SS_COLS, "O'Brien", 25, 0)
  check("the search term is escaped", sql.includes("O''Brien"), sql)
  check("quotes stay balanced", (sql.match(/'/g) || []).length % 2 === 0)
  check("searches the id as well as the name", sql.includes("CAST(CAMPAIGNID AS VARCHAR) LIKE"), sql)
  check("keeps the active filter alongside the search", sql.includes("ACTIVE = 1"), sql)
}
{
  const sql = buildCampaignCount(SS_SOURCE, SS_COLS, "x")
  check("the count uses the same filters as the list", sql.includes("ACTIVE = 1") && sql.includes("LIKE"))
  check("and does not paginate", !sql.includes("LIMIT"), sql)
  // A count that ignored the tenant scope would report more campaigns than the
  // list can ever show, and the pager would offer pages that come back empty.
  const y = buildCampaignCount(YAXXA_SOURCE, Y_COLS, "")
  check("the Yaxxa count carries the tenant scope too", y.includes("TENANT_ID = 1002"), y)
}

console.log("\nbuildAttach — this is where the cardinality lives")
{
  const sql = buildAttach("11204", "MTN Save", "Y7", "MTN Save Outbound", "me@x.com")
  // An INSERT here would let a Yaxxa campaign have two parents, which is the
  // one state the key exists to prevent.
  check("is a MERGE, not an INSERT", /^MERGE INTO/.test(sql), sql.slice(0, 40))
  check("matches on the Yaxxa id alone", sql.includes("ON t.YAXXA_CAMPAIGNID = s.Y"), sql)
  check("so re-attaching MOVES rather than duplicating",
    sql.includes("WHEN MATCHED THEN UPDATE SET") && sql.includes("SS_CAMPAIGNID = '11204'"), sql)
  check("records who did it", sql.includes("'me@x.com'"))
  check("snapshots both names", sql.includes("'MTN Save'") && sql.includes("'MTN Save Outbound'"))
  check("is a single statement", sql.split(";").length === 1)
}
{
  const sql = buildAttach("1", null, "Y'2", null, "me@x.com")
  check("a quote in the id is escaped", sql.includes("'Y''2'"), sql)
  check("null names become empty strings, not the text 'null'", !sql.includes("'null'"), sql)
}

console.log("\nbuildDetach")
{
  const sql = buildDetach("11204", "Y7")
  // Scoped to both, so a stale screen cannot detach a mapping that has since
  // been moved to somebody else.
  check("scoped to the pair, not just the Yaxxa id",
    sql.includes("YAXXA_CAMPAIGNID = 'Y7'") && sql.includes("SS_CAMPAIGNID = '11204'"), sql)
  check("deletes exactly one thing", (sql.match(/DELETE FROM/g) || []).length === 1)
}

console.log("\nreads and health checks")
{
  check("the map table keys on the Yaxxa campaign",
    buildEnsureMapTable().includes("PRIMARY KEY (YAXXA_CAMPAIGNID)"), buildEnsureMapTable())
  const sql = buildMappingsFor(["a'b", "c"])
  check("mapping ids are escaped", sql.includes("'a''b'"), sql)
  check("owner lookup targets the map table", buildOwnerOf("Y1").includes(MAP_TABLE))
}
{
  const sql = buildUnmappedCount(SS_COLS)
  check("unmapped counts active campaigns with no row", sql.includes("NOT EXISTS") && sql.includes("ACTIVE = 1"), sql)
}
{
  const sql = buildStaleMappings(SS_COLS, Y_COLS)
  check("stale checks BOTH sides", sql.includes("SS_GONE") && sql.includes("YAXXA_GONE"), sql)
  check("uses LEFT JOINs so a missing row is the finding, not an exclusion",
    (sql.match(/LEFT JOIN/g) || []).length === 2, sql)
  check("is read-only", !/\b(INSERT|UPDATE|DELETE|MERGE)\b/i.test(sql))
}
{
  const sql = buildDoubleBookedCheck()
  // Snowflake does not enforce primary keys, so the constraint encoding the
  // whole cardinality is documentation unless something checks it.
  check("finds a Yaxxa campaign claimed twice", sql.includes("HAVING COUNT(*) > 1"), sql)
  check("and names who claimed it", sql.includes("LISTAGG(DISTINCT SS_CAMPAIGNID"), sql)
}

console.log("\nbuildMapView")
{
  const sql = buildMapView(SS_COLS, Y_COLS)
  check("carries COPY GRANTS so replacing it keeps access", sql.includes("COPY GRANTS"), sql)
  check("prefers the live name over the snapshot",
    sql.includes("IFNULL(s.TITLE, m.SS_TITLE)") && sql.includes("IFNULL(y.CAMP_NAME, m.YAXXA_NAME)"), sql)
  check("exposes IS_STALE rather than dropping stale rows", sql.includes("IS_STALE"), sql)
  check("keeps stale rows visible via LEFT JOIN", (sql.match(/LEFT JOIN/g) || []).length === 2, sql)
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
