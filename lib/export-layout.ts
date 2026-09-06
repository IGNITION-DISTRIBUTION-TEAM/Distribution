/**
 * The CXM export's column layout, as data rather than a hardcoded SELECT list.
 *
 * WHY THIS EXISTS. `buildQuery` used to hold one 55-column SELECT list and use
 * it for every campaign. Every campaign is different: Spot Connect 1 needs 57
 * columns including "Region Code" and "REGION", and a NULL where another
 * campaign wants UDM3. Rather than pick a winner, the layout became
 * configuration, and today's list became `DEFAULT_LAYOUT` — what a campaign
 * that has configured nothing still gets.
 *
 * THE GRAMMAR IS THE SECURITY BOUNDARY. What comes out of here is interpolated
 * into a SELECT executed under a privileged Snowflake role, and it originates
 * in a settings form. So every part is checked against a closed set and
 * REJECTED on mismatch, never escaped — the same stance `ident()` takes in
 * lib/sftp-sync-codegen.ts, and for the same reason: an identifier that needs
 * escaping to be legal is a configuration mistake, and escaping it hides that.
 *
 * There is deliberately no free-text expression option. A "paste your SQL"
 * field here would be remote code execution wearing a settings label.
 *
 * ALIASES ARE ALWAYS QUOTED, and `out` is literally the CSV header. That is not
 * cosmetic. Snowflake folds an unquoted alias to upper case, so the old
 * `as LeadExpiry` actually produced a column called LEADEXPIRY — which is what
 * the received files show. Quoting everything and storing the exact header
 * removes that trap: what the editor displays is what lands in the file.
 */

/* ------------------------------------------------------------- transforms */

/**
 * One column in, one expression out. `COL` is substituted with the validated
 * source column; `EXPIRY` with the campaign's validated lead-expiry integer.
 */
export const TRANSFORMS = {
  raw: { label: "As is", sql: "COL" },
  trim: { label: "Trim spaces", sql: "RTRIM(LTRIM(COL))" },
  scrub: {
    label: "Strip odd characters",
    sql: "REGEXP_REPLACE(COL, '[^a-zA-Z0-9|:,.\\s-]', ' ')",
  },
  phone: {
    label: "Phone number fix (CXM)",
    sql: "DATAWAREHOUSE.DISTRIBUTION.SF_PHONE_NUMBER_FIX_CXM(COL)",
  },
  left6: { label: "First 6 characters", sql: "LEFT(COL, 6)" },
  date: { label: "As a date", sql: "CAST(COL AS DATE)" },
  int: { label: "As a whole number", sql: "COL::INT" },
  plusExpiry: {
    label: "Date + lead expiry days",
    sql: "CAST(COL AS DATE) + EXPIRY",
  },
} as const

export type TransformId = keyof typeof TRANSFORMS

/* ---------------------------------------------------------------- presets */

/**
 * Expressions that cannot be a pair of dropdowns: they read several columns,
 * or branch, or depend on which SilverSurfer lookup tier survived. Selectable
 * but not editable — decomposing them would mean a far larger grammar to
 * secure for no practical gain.
 *
 * `SS_LOOKUP` is substituted with the tier-dependent expression, exactly as
 * the old inline `${ssExpr}` was.
 */
export const PRESETS = {
  idNumberOrCell: {
    label: "ID number, falling back to the cell number",
    sql: "RTRIM(IFNULL(A.IDNUMBER, CELLNUMBER))",
  },
  optinStatusText: {
    label: "Opt-in status as words",
    sql: `CASE
       WHEN OPTINSTATUS::INT = 0 THEN 'CUSTOMER NOT OPTED IN'
       WHEN OPTINSTATUS::INT = 1 THEN 'CUSTOMER ALREADY OPTED'
       WHEN OPTINSTATUS::INT = 2 THEN 'CUSTOMER ALREADY OPTED OUT'
       END`,
  },
  ssLeadCustomerId: {
    label: "SilverSurfer lead customer id",
    sql: "SS_LOOKUP",
  },
  contactNumber2: {
    label: "Second contact number (blank if it repeats the cell number)",
    sql: `CASE WHEN DATAWAREHOUSE.DISTRIBUTION.SF_PHONE_NUMBER_FIX_CXM(CONTACTNUMBER1) = DATAWAREHOUSE.DISTRIBUTION.SF_PHONE_NUMBER_FIX_CXM(CELLNUMBER)
        THEN NULL ELSE DATAWAREHOUSE.DISTRIBUTION.SF_PHONE_NUMBER_FIX_CXM(CONTACTNUMBER1) END`,
  },
  contactNumber3: {
    label: "Third contact number (blank if it repeats either of the others)",
    sql: `CASE WHEN DATAWAREHOUSE.DISTRIBUTION.SF_PHONE_NUMBER_FIX_CXM(CONTACTNUMBER2) = DATAWAREHOUSE.DISTRIBUTION.SF_PHONE_NUMBER_FIX_CXM(CONTACTNUMBER1)
        OR DATAWAREHOUSE.DISTRIBUTION.SF_PHONE_NUMBER_FIX_CXM(CONTACTNUMBER2) = DATAWAREHOUSE.DISTRIBUTION.SF_PHONE_NUMBER_FIX_CXM(CELLNUMBER)
        THEN NULL ELSE DATAWAREHOUSE.DISTRIBUTION.SF_PHONE_NUMBER_FIX_CXM(CONTACTNUMBER2) END`,
  },
} as const

export type PresetId = keyof typeof PRESETS

/* ----------------------------------------------------------------- shapes */

export type ColumnSpec = {
  /** The CSV header, exactly. Always emitted double-quoted. */
  out: string
  kind: "null" | "column" | "preset"
  /** kind "column": a column on the HLL table, checked against the live list. */
  source?: string
  /** kind "column": defaults to "raw". */
  transform?: TransformId
  /**
   * kind "null": a typed NULL. Snowflake's SQL API reports the declared type,
   * and lib/dialler-csv.ts formats a value by it — so `CAST(NULL AS NUMBER)`
   * and bare `NULL` are not interchangeable.
   */
  nullType?: "number"
  /** kind "preset". */
  preset?: PresetId
}

export type ExportLayout = { columns: ColumnSpec[] }

/** Substituted into every preset that needs it, by `renderSelectList`. */
export type RenderContext = {
  /** Already validated as an integer by the caller. */
  expiryDays: number
  /** "LEADCUSTOMERID", or "NULL" when the SilverSurfer lookup is unavailable. */
  ssLookup: string
}

/* ------------------------------------------------------------- validation */

/**
 * The alias grammar, which is NOT the identifier grammar used elsewhere here.
 *
 * Every other validator in this repo is `/^[A-Za-z0-9_]+$/`, which rejects
 * "First Name", "Region Code" and "Next Dial Time" — all real CXM headers. So
 * spaces are allowed, and the alias is always emitted double-quoted. A double
 * quote or a backslash is refused outright: those are the only characters that
 * could terminate the quoted identifier.
 */
const OUT_RE = /^[A-Za-z0-9_ ]{1,64}$/

/** Source and preset column references. Same shape as the repo's `IDENT`. */
const IDENT_RE = /^[A-Za-z0-9_]{1,255}$/

/** Without this the per-batch file naming silently collapses — see validateLayout. */
export const REQUIRED_OUT = "BATCHNAME"

export const MAX_COLUMNS = 200

export type LayoutProblem = { index: number; message: string }

/**
 * Check a layout against the closed grammar.
 *
 * `knownColumns` is the live column set for the HLL table, upper-cased. Pass
 * null to skip that one check — used where the list is not to hand, never as a
 * way to accept an unknown column into SQL.
 */
export function validateLayout(
  layout: unknown,
  knownColumns: Set<string> | null
): { ok: true; layout: ExportLayout } | { ok: false; problems: LayoutProblem[] } {
  const problems: LayoutProblem[] = []
  const raw = (layout as ExportLayout)?.columns
  if (!Array.isArray(raw)) {
    return { ok: false, problems: [{ index: -1, message: "Layout must have a columns array" }] }
  }
  if (raw.length === 0) {
    return { ok: false, problems: [{ index: -1, message: "A layout needs at least one column" }] }
  }
  if (raw.length > MAX_COLUMNS) {
    return {
      ok: false,
      problems: [{ index: -1, message: `A layout is capped at ${MAX_COLUMNS} columns` }],
    }
  }

  const seen = new Set<string>()
  const out: ColumnSpec[] = []

  raw.forEach((c: ColumnSpec, i) => {
    const name = typeof c?.out === "string" ? c.out.trim() : ""
    if (!OUT_RE.test(name)) {
      problems.push({
        index: i,
        message: `Column name ${JSON.stringify(c?.out ?? "")} must be 1-64 letters, digits, underscores or spaces`,
      })
      return
    }
    const key = name.toUpperCase()
    if (seen.has(key)) {
      // Two identically-named CSV columns is not something a consumer can
      // recover from, and it is silent — so it is refused here.
      problems.push({ index: i, message: `Duplicate column name ${name}` })
      return
    }
    seen.add(key)

    if (c.kind === "null") {
      if (c.nullType !== undefined && c.nullType !== "number") {
        problems.push({ index: i, message: `${name}: unknown null type` })
        return
      }
      out.push({ out: name, kind: "null", ...(c.nullType ? { nullType: c.nullType } : {}) })
      return
    }

    if (c.kind === "preset") {
      if (!c.preset || !(c.preset in PRESETS)) {
        problems.push({ index: i, message: `${name}: unknown preset ${JSON.stringify(c.preset)}` })
        return
      }
      out.push({ out: name, kind: "preset", preset: c.preset })
      return
    }

    if (c.kind === "column") {
      const source = typeof c.source === "string" ? c.source.trim() : ""
      if (!IDENT_RE.test(source)) {
        problems.push({
          index: i,
          message: `${name}: source column ${JSON.stringify(c.source ?? "")} must be letters, digits and underscores only`,
        })
        return
      }
      if (knownColumns && !knownColumns.has(source.toUpperCase())) {
        // Rejected, not quoted. A column that is not on the table is a
        // configuration mistake, and passing it through would turn it into a
        // Snowflake compilation error at download time instead.
        problems.push({ index: i, message: `${name}: no column called ${source} on the leads table` })
        return
      }
      const transform = (c.transform ?? "raw") as TransformId
      if (!(transform in TRANSFORMS)) {
        problems.push({ index: i, message: `${name}: unknown transform ${JSON.stringify(c.transform)}` })
        return
      }
      out.push({ out: name, kind: "column", source: source.toUpperCase(), transform })
      return
    }

    problems.push({ index: i, message: `${name}: unknown kind ${JSON.stringify(c?.kind)}` })
  })

  if (!seen.has(REQUIRED_OUT)) {
    problems.push({
      index: -1,
      // Without it, buildExportFiles finds no BATCHNAME column, skips the
      // per-batch grouping and emits one generically-named file. The file name
      // IS what the dialler team keys on, so that degradation is refused.
      message: `A layout must include a ${REQUIRED_OUT} column — the export names each file after it`,
    })
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true, layout: { columns: out } }
}

/* -------------------------------------------------------------- rendering */

/** The SQL for one column, without its alias. */
export function renderExpression(spec: ColumnSpec, ctx: RenderContext): string {
  if (spec.kind === "null") {
    return spec.nullType === "number" ? "CAST(NULL AS NUMBER(38, 0))" : "NULL"
  }
  if (spec.kind === "preset") {
    return PRESETS[spec.preset as PresetId].sql.replace(/SS_LOOKUP/g, ctx.ssLookup)
  }
  const template = TRANSFORMS[(spec.transform ?? "raw") as TransformId].sql

  /**
   * ONE PASS, NOT TWO CHAINED REPLACES.
   *
   * Chaining `.replace(/COL/…).replace(/EXPIRY/…)` re-scans the first
   * substitution's output, so a column whose own name contains a placeholder
   * gets mangled — and there is a real column called LEADEXPIRY, which came
   * out as `a.LEAD45`. A single regex with a replacer function never looks at
   * text it has already written.
   *
   * The source is qualified with the base table's alias, always. The
   * SilverSurfer CTE is joined as `b` and also carries IDNUMBER, so an
   * unqualified reference to that is ambiguous and Snowflake rejects the whole
   * statement. Qualifying every source column removes the class, not the case.
   */
  return template.replace(/COL|EXPIRY/g, (token) =>
    token === "COL" ? `a.${spec.source as string}` : String(ctx.expiryDays)
  )
}

/**
 * The whole SELECT list, one column per line in the shape buildQuery emits.
 *
 * Assumes the layout has been through `validateLayout` — every value it
 * interpolates comes from a closed set or has been checked against the live
 * column list. It does not re-check, deliberately: two places that both
 * half-validate is how a gap opens.
 */
export function renderSelectList(layout: ExportLayout, ctx: RenderContext): string {
  return layout.columns
    .map((spec, i) => {
      const prefix = i === 0 ? "SELECT " : "     , "
      return `${prefix}${renderExpression(spec, ctx)} AS "${spec.out}"`
    })
    .join("\n")
}

/* ---------------------------------------------------------------- default */

const nul = (out: string): ColumnSpec => ({ out, kind: "null" })
const num = (out: string): ColumnSpec => ({ out, kind: "null", nullType: "number" })
const col = (out: string, source: string, transform: TransformId = "raw"): ColumnSpec => ({
  out,
  kind: "column",
  source,
  transform,
})
const pre = (out: string, preset: PresetId): ColumnSpec => ({ out, kind: "preset", preset })

/**
 * The layout every campaign gets until somebody configures one.
 *
 * This IS the list `buildQuery` used to hold inline, transcribed. The header
 * names are the ones the exported files actually carry — verified against a
 * real file off the Teams channel — which is why LEADEXPIRY is upper case
 * here: the old query's unquoted `as LeadExpiry` was folded by Snowflake, and
 * reproducing that faithfully matters more than the prettier spelling.
 *
 * CREATEDONDATE and LEADEXPIRY both read the row's own load date rather than
 * the export date. See buildQuery's doc for why that is load bearing once a
 * date can be picked.
 */
export const DEFAULT_LAYOUT: ExportLayout = {
  columns: [
    col("First Name", "CUSTOMERNAME", "trim"),
    col("Last Name", "LASTNAME", "trim"),
    col("Contact No", "CELLNUMBER", "phone"),
    col("Email ID", "EMAIL"),
    col("Address", "UDM7", "scrub"),
    pre("IDNUMBER", "idNumberOrCell"),
    col("MASKID", "IDNUMBER", "left6"),
    col("CAMPAIGNID", "CAMPAIGNID"),
    col("BATCHNAME", "BATCHNAME"),
    col("CREATEDONDATE", "CREATEDONDATE", "date"),
    col("LEADEXPIRY", "CREATEDONDATE", "plusExpiry"),
    nul("BANK"),
    nul("BANKACCOUNTTYPE"),
    nul("BRANCHCODE"),
    nul("SERIAL_NUMBER"),
    nul("DEBIT_DAY"),
    nul("AVERAGESPEND"),
    nul("MARKETING_OFFER_DESC"),
    nul("ORDERDATE"),
    col("ADDRESS_RANK", "UDM3", "scrub"),
    nul("SOURCEORDER"),
    nul("DEVICE_VALUE"),
    nul("CONTRACTTYPE"),
    nul("PAYDAY"),
    nul("SOURCE"),
    nul("UPGRADE_DATE"),
    nul("ACTIVATIONDATE"),
    nul("MVNX_NUMBER"),
    col("LTE_COVERAGE", "UDM6", "scrub"),
    nul("INSURANCEPRICE"),
    nul("PREMIUM"),
    col("PROVINCE", "UDM9", "scrub"),
    nul("HANDSETPRICE"),
    num("PROVINCE_RANK"),
    nul("DEVICE_TYPE"),
    nul("DATE_OF_PURCHASE"),
    nul("TAKEUP_PROB"),
    num("MATOGEN_SCORE"),
    col("SCORE", "SCORE"),
    col("SCOREGROUP", "SCOREGROUP"),
    pre("OPTINSTATUS", "optinStatusText"),
    col("PROPENSITYTOCONNECT", "PROPENSITYTOCONNECT", "int"),
    nul("SKILL"),
    nul("BANK_ACCOUNT_MASKED"),
    col("HLL_ID", "HLL_ID"),
    nul("CURRENT_PACKAGE"),
    col("DATA_DAY_RANK", "UDM30", "scrub"),
    nul("DEVICE_DETAILS"),
    nul("PROVIDER_ACCOUNT_NUMBER"),
    pre("SS_LEADCUSTOMERID", "ssLeadCustomerId"),
    pre("CONTACTNUMBER2", "contactNumber2"),
    pre("CONTACTNUMBER3", "contactNumber3"),
    nul("COMMENT"),
    col("EXTRADATA", "EXTRADATA", "scrub"),
    nul("Next Dial Time"),
  ],
}

/** A deep copy, so an editor cannot mutate the shared default in place. */
export function defaultLayout(): ExportLayout {
  return JSON.parse(JSON.stringify(DEFAULT_LAYOUT)) as ExportLayout
}

/** Parse a stored JSON string, falling back to the default on anything odd. */
export function parseLayout(raw: unknown): ExportLayout {
  if (typeof raw !== "string" || !raw.trim()) return defaultLayout()
  try {
    const parsed: unknown = JSON.parse(raw)
    const checked = validateLayout(parsed, null)
    return checked.ok ? checked.layout : defaultLayout()
  } catch {
    return defaultLayout()
  }
}
