/**
 * Mapping active SilverSurfer campaigns to Yaxxa dialler campaigns.
 *
 * PURE SQL BUILDERS, NO I/O — the routes execute, this module only says what to
 * execute, so the statements are testable from literals. Same shape as
 * lib/billing-mappings.ts.
 *
 * -----------------------------------------------------------------------------
 * ONE SILVERSURFER CAMPAIGN, MANY YAXXA CAMPAIGNS
 *
 * That is the agreed cardinality and it decides everything else. The map is one
 * row per pair, keyed on the YAXXA id rather than on the pair — because a Yaxxa
 * campaign belongs to at most one SilverSurfer campaign, and making that the key
 * is what stops it belonging to two.
 *
 * The consequence, which the UI has to say out loud: attaching a Yaxxa campaign
 * that is already attached somewhere else MOVES it. Silently re-parenting a
 * dialler campaign is exactly the sort of thing that should not happen quietly,
 * so the route reports what it moved from.
 *
 * -----------------------------------------------------------------------------
 * THE SOURCE COLUMNS ARE RESOLVED AT RUN TIME, NOT GUESSED
 *
 * Nothing in this repo has touched YAXXA_DW_REPLICATION before, and
 * SILVERSURFER.CAMP_CAMPAIGN is a different table from the one
 * app/api/campaigns/route.ts reads. Hard-coding a guess at their id and label
 * columns would fail as "invalid identifier" with nothing pointing at the
 * cause.
 *
 * So each side declares an ORDERED list of candidate columns, the route probes
 * INFORMATION_SCHEMA once and takes the first that exists, and the screen
 * displays what it resolved. A wrong guess is then visible on the screen rather
 * than silent, and correcting it is one edit to a list here.
 *
 * The same pattern is already in app/api/admin/employees/route.ts, for the same
 * reason: an install with a different schema must not break the query.
 */
import { lit } from "@/lib/sql-literal"

export type CampaignSource = {
  /** Fully qualified, for the query. */
  table: string
  database: string
  schema: string
  name: string
  /** Restricts the list to campaigns worth mapping. Empty means no filter. */
  activeFilter: string
  /** First match wins. */
  idCandidates: string[]
  labelCandidates: string[]
  /**
   * Columns worth SHOWING if the table has them — status, type, and so on.
   * Resolved by the same probe, so a source without them degrades quietly
   * instead of erroring on an invalid identifier.
   */
  extraCandidates?: string[]
}

/**
 * NOTE THE SCHEMA. This is SILVERSURFER.CAMP_CAMPAIGN, which is NOT the table
 * app/api/campaigns/route.ts reads for the Distribution picker — that one is
 * SILVERSURFER_CAMP_HEVO.CAMPAIGN. If the two ever disagree about which
 * campaigns are active, the two screens disagree about the same question.
 * scripts/dialler/00-discover-columns.sql section 3 compares them.
 */
export const SS_SOURCE: CampaignSource = {
  table: "DATAWAREHOUSE.SILVERSURFER.CAMP_CAMPAIGN",
  database: "DATAWAREHOUSE",
  schema: "SILVERSURFER",
  name: "CAMP_CAMPAIGN",
  activeFilter: "ACTIVE = 1",
  idCandidates: ["CAMPAIGNID", "CAMPAIGN_ID", "CAMPID", "ID"],
  labelCandidates: ["TITLE", "CAMPAIGNNAME", "CAMPAIGN_NAME", "NAME", "DESCRIPTION"],
}

/**
 * CONFIRMED AGAINST THE REAL TABLE. The first attempt guessed CAMPAIGN_ID and
 * CAMPAIGN_NAME and resolved neither — which the screen reported, naming every
 * candidate it had tried. That is what the probe is for.
 *
 * TENANT_ID = 1002 IS A REAL FILTER, NOT TIDYING. The dialler is multi-tenant:
 * 1000 and 1001 carry Internal, inbound_camp, outbound_camp and auto_camp, and
 * mapping a SilverSurfer campaign to another tenant's test campaign would be
 * quietly wrong rather than an error.
 *
 * `IFNULL(_EDGE_DELETED, FALSE) = FALSE` can only ever exclude a row the
 * replication has explicitly flagged as deleted; a null or a missing column
 * keeps the row. That asymmetry is deliberate — if the semantics are not what
 * they look like, the failure is showing too much rather than an empty picker
 * nobody can explain.
 *
 * NO FILTER ON CAMP_STATUS. It holds Y, X and N, and nobody has confirmed what
 * they mean — Y clusters on newer ids and X on older ones, which is suggestive
 * and not evidence. It is shown on every row instead, so the person attaching
 * a campaign can see it and decide.
 */
export const YAXXA_SOURCE: CampaignSource = {
  table: "DATAWAREHOUSE.YAXXA_DW_REPLICATION.CAMPAIGN_MASTER",
  database: "DATAWAREHOUSE",
  schema: "YAXXA_DW_REPLICATION",
  name: "CAMPAIGN_MASTER",
  activeFilter: "TENANT_ID = 1002 AND IFNULL(_EDGE_DELETED, FALSE) = FALSE",
  idCandidates: ["CAMP_ID", "CAMPAIGN_ID", "CAMPAIGNID", "ID"],
  labelCandidates: ["CAMP_NAME", "CAMPAIGN_NAME", "CAMPAIGNNAME", "NAME", "TITLE"],
  // CAMP_NAME is sometimes the cryptic one — "VCCVMUpgrades" with CAMP_DESC
  // "VC CVM Upgrades" — so the description earns its place in the picker.
  extraCandidates: ["CAMP_STATUS", "CAMP_TYPE", "CAMP_DIALER", "CAMP_DESC"],
}

export const MAP_TABLE = "DATAWAREHOUSE.LEADS_DISTRIBUTION.TSK_CAMPAIGN_DIALLER_MAP"
export const MAP_VIEW = "DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_CAMPAIGN_DIALLER_MAP"
export const MAP_SF_OPTS = { database: "DATAWAREHOUSE", schema: "LEADS_DISTRIBUTION" } as const

/** Which columns a probe settled on. Null means nothing matched. */
export type ResolvedColumns = {
  id: string | null
  label: string | null
  /** Display-only columns that exist. Empty when the source declares none. */
  extras: string[]
}

/** Every column on a source, so the route can pick from the candidates. */
export function buildColumnProbe(source: CampaignSource): string {
  return (
    `SELECT COLUMN_NAME FROM ${source.database}.INFORMATION_SCHEMA.COLUMNS\n` +
    ` WHERE TABLE_SCHEMA = ${lit(source.schema)} AND TABLE_NAME = ${lit(source.name)}`
  )
}

/**
 * First candidate that exists, or null.
 *
 * Ordered, not "any match": CAMPAIGNID before ID matters when a table has both,
 * and TITLE before DESCRIPTION picks the short human label over the long one.
 */
export function resolveColumns(source: CampaignSource, present: string[]): ResolvedColumns {
  const have = new Set(present.map((c) => c.toUpperCase()))
  return {
    id: source.idCandidates.find((c) => have.has(c)) ?? null,
    label: source.labelCandidates.find((c) => have.has(c)) ?? null,
    extras: (source.extraCandidates ?? []).filter((c) => have.has(c)),
  }
}

/**
 * Which SilverSurfer campaigns to list.
 *
 *   unmapped  nothing attached yet — the queue of work
 *   mapped    already has at least one Yaxxa campaign — the review list
 *   all       everything active
 */
export type MapFilter = "all" | "mapped" | "unmapped"

/**
 * Correlated EXISTS against the map, for the tab filters.
 *
 * A JOIN would multiply a campaign by its number of attached Yaxxa campaigns —
 * a one-to-many mapping joined naively turns a list of campaigns into a list of
 * pairs, and the pager would then report far more rows than the screen shows.
 * EXISTS asks the only question the tabs need: is there at least one?
 */
export function mapFilterClause(alias: string, cols: ResolvedColumns, mode: MapFilter): string {
  if (mode === "all") return ""
  const exists =
    `EXISTS (SELECT 1 FROM ${MAP_TABLE} m ` +
    `WHERE m.SS_CAMPAIGNID = CAST(${alias}.${cols.id} AS VARCHAR))`
  return mode === "mapped" ? exists : `NOT ${exists}`
}

/** Is a resolved pair usable? Both halves are needed to render a picker. */
export function isResolved(cols: ResolvedColumns): boolean {
  return Boolean(cols.id && cols.label)
}

function whereClauses(parts: string[]): string {
  const live = parts.filter(Boolean)
  return live.length === 0 ? "" : `\n WHERE ${live.join("\n   AND ")}`
}

/**
 * A page of campaigns from either source.
 *
 * `cols` comes from resolveColumns, so it is one of this module's own candidate
 * strings and never caller input — which is why it can be interpolated as an
 * identifier. The search TERM is a value and goes through lit().
 */
export function buildCampaigns(
  source: CampaignSource,
  cols: ResolvedColumns,
  search: string,
  limit: number,
  offset: number,
  /** Only meaningful for the SilverSurfer side; the Yaxxa list has no tabs. */
  mode: MapFilter = "all"
): string {
  const q = search.trim()
  const filter = q
    ? `(UPPER(c.${cols.label}) LIKE UPPER(${lit(`%${q}%`)}) ` +
      `OR CAST(c.${cols.id} AS VARCHAR) LIKE ${lit(`%${q}%`)})`
    : ""
  // Aliased EXTRA_n rather than by their own names, so the route and the UI do
  // not have to know which columns a given source happens to carry.
  const extras = cols.extras.map((col, i) => `, c.${col} AS EXTRA_${i}`).join("")
  // Aliased `c` so the EXISTS subquery has something to correlate against.
  return (
    `SELECT CAST(c.${cols.id} AS VARCHAR) AS CAMPAIGN_ID, c.${cols.label} AS LABEL${extras}\n` +
    `  FROM ${source.table} c` +
    whereClauses([source.activeFilter, filter, mapFilterClause("c", cols, mode)]) +
    `\n ORDER BY c.${cols.label}\n LIMIT ${limit} OFFSET ${offset}`
  )
}

export function buildCampaignCount(
  source: CampaignSource,
  cols: ResolvedColumns,
  search: string,
  mode: MapFilter = "all"
): string {
  const q = search.trim()
  const filter = q
    ? `(UPPER(c.${cols.label}) LIKE UPPER(${lit(`%${q}%`)}) ` +
      `OR CAST(c.${cols.id} AS VARCHAR) LIKE ${lit(`%${q}%`)})`
    : ""
  return (
    `SELECT COUNT(*) AS CNT FROM ${source.table} c` +
    whereClauses([source.activeFilter, filter, mapFilterClause("c", cols, mode)])
  )
}

// -------------------------------------------------------------------- the map

export function buildEnsureMapTable(): string {
  return (
    `CREATE TABLE IF NOT EXISTS ${MAP_TABLE} (\n` +
    `  SS_CAMPAIGNID    VARCHAR NOT NULL,\n` +
    `  SS_TITLE         VARCHAR,\n` +
    `  YAXXA_CAMPAIGNID VARCHAR NOT NULL,\n` +
    `  YAXXA_NAME       VARCHAR,\n` +
    `  CREATED_AT       TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),\n` +
    `  CREATED_BY       VARCHAR,\n` +
    `  CONSTRAINT PK_TSK_CAMPAIGN_DIALLER_MAP PRIMARY KEY (YAXXA_CAMPAIGNID)\n)`
  )
}

/** Every mapping for the SilverSurfer campaigns on the current page. */
export function buildMappingsFor(ssIds: string[]): string {
  const list = ssIds.map((id) => lit(id)).join(", ")
  return (
    `SELECT SS_CAMPAIGNID, YAXXA_CAMPAIGNID, YAXXA_NAME, SS_TITLE, CREATED_BY, CREATED_AT\n` +
    `  FROM ${MAP_TABLE}\n WHERE SS_CAMPAIGNID IN (${list})\n ORDER BY YAXXA_NAME, YAXXA_CAMPAIGNID`
  )
}

/** Who currently owns this Yaxxa campaign, if anyone. Read before attaching. */
export function buildOwnerOf(yaxxaId: string): string {
  return (
    `SELECT SS_CAMPAIGNID, SS_TITLE FROM ${MAP_TABLE}\n` +
    ` WHERE YAXXA_CAMPAIGNID = ${lit(yaxxaId)}`
  )
}

/**
 * Attach a Yaxxa campaign to a SilverSurfer campaign.
 *
 * MERGE on the Yaxxa id, so attaching one that already belongs elsewhere MOVES
 * it rather than creating a second row. That is the cardinality made real: an
 * INSERT here would quietly produce the two-parent state the whole key exists
 * to prevent.
 *
 * The two name columns are a snapshot for display when a campaign later
 * disappears from its source; the live name always wins where there is one.
 */
export function buildAttach(
  ssId: string,
  ssTitle: string | null,
  yaxxaId: string,
  yaxxaName: string | null,
  actor: string
): string {
  return (
    `MERGE INTO ${MAP_TABLE} t\n` +
    `USING (SELECT ${lit(yaxxaId)} AS Y) s\n` +
    `   ON t.YAXXA_CAMPAIGNID = s.Y\n` +
    ` WHEN MATCHED THEN UPDATE SET\n` +
    `        SS_CAMPAIGNID = ${lit(ssId)},\n` +
    `        SS_TITLE = ${lit(ssTitle ?? "")},\n` +
    `        YAXXA_NAME = ${lit(yaxxaName ?? "")},\n` +
    `        CREATED_BY = ${lit(actor)},\n` +
    `        CREATED_AT = CURRENT_TIMESTAMP()\n` +
    ` WHEN NOT MATCHED THEN INSERT\n` +
    `        (SS_CAMPAIGNID, SS_TITLE, YAXXA_CAMPAIGNID, YAXXA_NAME, CREATED_BY)\n` +
    ` VALUES (${lit(ssId)}, ${lit(ssTitle ?? "")}, ${lit(yaxxaId)}, ` +
    `${lit(yaxxaName ?? "")}, ${lit(actor)})`
  )
}

/**
 * Detach one Yaxxa campaign.
 *
 * Scoped to the SilverSurfer campaign as well as the Yaxxa one, so a stale
 * screen cannot detach a mapping that has since been moved to somebody else.
 */
export function buildDetach(ssId: string, yaxxaId: string): string {
  return (
    `DELETE FROM ${MAP_TABLE}\n` +
    ` WHERE YAXXA_CAMPAIGNID = ${lit(yaxxaId)}\n   AND SS_CAMPAIGNID = ${lit(ssId)}`
  )
}

// ----------------------------------------------------------- health checks

/**
 * How many active campaigns there are, and how many already have something
 * attached — for the tab labels.
 *
 * ONE SCAN FOR BOTH. Three separate counts would be three passes over the same
 * table to draw three numbers that must add up, and any drift between them
 * would show as tabs whose totals disagree.
 *
 * It honours the SEARCH, so the tab counts describe what the current search
 * would show rather than the whole table — otherwise "Mapped 15" next to an
 * empty Mapped tab is the obvious confusion.
 */
export function buildTabCounts(cols: ResolvedColumns, search: string): string {
  const q = search.trim()
  const filter = q
    ? `(UPPER(c.${cols.label}) LIKE UPPER(${lit(`%${q}%`)}) ` +
      `OR CAST(c.${cols.id} AS VARCHAR) LIKE ${lit(`%${q}%`)})`
    : ""
  // DISTINCT in the CTE because the map is one row per PAIR — a campaign with
  // three Yaxxa campaigns attached must count once, not three times.
  return (
    `WITH MAPPED AS (SELECT DISTINCT SS_CAMPAIGNID FROM ${MAP_TABLE})\n` +
    `SELECT COUNT(*)                              AS TOTAL,\n` +
    `       COUNT_IF(m.SS_CAMPAIGNID IS NOT NULL) AS MAPPED\n` +
    `  FROM ${SS_SOURCE.table} c\n` +
    `  LEFT JOIN MAPPED m ON m.SS_CAMPAIGNID = CAST(c.${cols.id} AS VARCHAR)` +
    whereClauses([SS_SOURCE.activeFilter, filter])
  )
}

/**
 * Mappings pointing at a campaign that is gone, or no longer active.
 *
 * THE ONE THAT ROTS QUIETLY. Campaigns are deactivated and replaced constantly;
 * a mapping to a campaign that no longer exists keeps matching nothing and
 * nobody finds out until a report is short. Both sides are checked, and the
 * snapshot names are what make the result readable — the live row is gone, so
 * the id is all that would otherwise be left.
 */
export function buildStaleMappings(
  ssCols: ResolvedColumns,
  yaxxaCols: ResolvedColumns
): string {
  return (
    `SELECT m.SS_CAMPAIGNID, m.SS_TITLE, m.YAXXA_CAMPAIGNID, m.YAXXA_NAME,\n` +
    `       IFF(s.${ssCols.id} IS NULL, TRUE, FALSE)  AS SS_GONE,\n` +
    `       IFF(y.${yaxxaCols.id} IS NULL, TRUE, FALSE) AS YAXXA_GONE\n` +
    `  FROM ${MAP_TABLE} m\n` +
    `  LEFT JOIN ${SS_SOURCE.table} s\n` +
    `    ON CAST(s.${ssCols.id} AS VARCHAR) = m.SS_CAMPAIGNID` +
    (SS_SOURCE.activeFilter ? `\n   AND s.${SS_SOURCE.activeFilter}` : "") +
    `\n  LEFT JOIN ${YAXXA_SOURCE.table} y\n` +
    `    ON CAST(y.${yaxxaCols.id} AS VARCHAR) = m.YAXXA_CAMPAIGNID\n` +
    ` WHERE s.${ssCols.id} IS NULL OR y.${yaxxaCols.id} IS NULL\n` +
    ` ORDER BY m.SS_TITLE, m.YAXXA_NAME`
  )
}

/**
 * A Yaxxa campaign attached to more than one SilverSurfer campaign.
 *
 * Should be impossible: YAXXA_CAMPAIGNID is the primary key. But SNOWFLAKE DOES
 * NOT ENFORCE PRIMARY KEYS — they are metadata — so the constraint that encodes
 * the whole cardinality is documentation unless something checks it. This is
 * that something.
 */
export function buildDoubleBookedCheck(): string {
  return (
    `SELECT YAXXA_CAMPAIGNID, COUNT(*) AS ROWS_FOUND,\n` +
    `       LISTAGG(DISTINCT SS_CAMPAIGNID, ', ') AS CLAIMED_BY\n` +
    `  FROM ${MAP_TABLE}\n GROUP BY 1 HAVING COUNT(*) > 1\n ORDER BY ROWS_FOUND DESC`
  )
}

/**
 * The view downstream reports join to.
 *
 * Lives in the app's schema, reads the map plus both sources for LIVE names,
 * and carries IS_STALE so a consumer can decide for itself whether to trust a
 * row rather than silently dropping it.
 */
export function buildMapView(ssCols: ResolvedColumns, yaxxaCols: ResolvedColumns): string {
  return (
    `CREATE OR REPLACE VIEW ${MAP_VIEW} COPY GRANTS AS\n` +
    `SELECT m.SS_CAMPAIGNID,\n` +
    `       IFNULL(s.${ssCols.label}, m.SS_TITLE)     AS SS_TITLE,\n` +
    `       m.YAXXA_CAMPAIGNID,\n` +
    `       IFNULL(y.${yaxxaCols.label}, m.YAXXA_NAME) AS YAXXA_NAME,\n` +
    `       (s.${ssCols.id} IS NULL OR y.${yaxxaCols.id} IS NULL) AS IS_STALE,\n` +
    `       m.CREATED_BY, m.CREATED_AT\n` +
    `  FROM ${MAP_TABLE} m\n` +
    `  LEFT JOIN ${SS_SOURCE.table} s\n` +
    `    ON CAST(s.${ssCols.id} AS VARCHAR) = m.SS_CAMPAIGNID\n` +
    `  LEFT JOIN ${YAXXA_SOURCE.table} y\n` +
    `    ON CAST(y.${yaxxaCols.id} AS VARCHAR) = m.YAXXA_CAMPAIGNID`
  )
}
