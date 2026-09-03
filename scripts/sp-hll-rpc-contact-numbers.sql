/* =============================================================================
   HLL contact-number cleanup, RPC-aware  (written for campaign 11389)
   -----------------------------------------------------------------------------
   Your seven statements as one procedure, in the same order, with the same
   effect, plus a row count per statement in the return value.

   An update-HLL procedure: it edits rows already in TM_HLL_HISTORYLEADSLOADED.

     Settings → Campaign automation → Update-HLL procedures:
       DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_HLL_RPC_CONTACT_NUMBERS(11389, 3)

   Two numeric parameters — the campaign and the RPC window in months — because
   all seven statements share both, and numbers are the only thing the config
   field will carry. Nothing else in here is campaign-specific, so this one
   procedure serves every campaign that wants the same treatment.

   NORMALISED ONLY: campaignid in ('11389') to a numeric parameter, and
   CAST(CREATEDONDATE AS DATE) for the date test. No logic touched.

   -----------------------------------------------------------------------------
   THE THREE THAT CHANGE WHICH NUMBERS GET DIALLED

   Read these before running it. Two of them cost you contact numbers on the
   leads you most want to reach, and the third writes malformed ones.

   A. THE RPC BLOCK UNDOES ITSELF, AND TAKES THE ALTERNATE NUMBERS WITH IT.

      Statements 1 and 2 both fire only when

          h.CELLNUMBER = CONCAT('0', SUBSTRING(RPC1, 3, 10))

      — that is, only when CELLNUMBER ALREADY IS the RPC number, just written
      locally rather than internationally. So neither can change which number
      you call. Trace one of those rows through all seven:

          1  CONTACTNUMBER1 := CELLNUMBER        '0821234567'
          2  CELLNUMBER     := RPC1              '27821234567'
          3  skipped — it requires CONTACTNUMBER1 IS NULL, and 1 just filled it
          4  CELLNUMBER     := local again       '0821234567'   (length > 10)
          5  CONTACTNUMBER1 := NULL              they now match
          6  skipped — CONTACTNUMBER1 <> … is UNKNOWN against the NULL from 5
          7  skipped — same reason

      Net effect on the row: none, except that it now has NO alternate numbers
      at all. Not CELL1, not CELL2, not CELL3. And these are your best leads —
      a right-party contact confirmed within the window.

      If the intent was "prefer the confirmed RPC number", the join condition
      wants to be <> rather than =: move RPC1 into CELLNUMBER when it is NOT
      already there, keeping the old number in CONTACTNUMBER1. As written with
      =, statements 1 and 2 are the two halves of a round trip.

   B. STATEMENT 7 OVERWRITES STATEMENT 6, SO CELL2 IS DISCARDED.

      Both set CONTACTNUMBER2 — 6 from CELL2, then 7 from CELL3. Neither has a
      CONTACTNUMBER2 IS NULL guard, so 7 simply replaces what 6 wrote whenever
      the two differ. CELL2 never reaches the dialler.

      Almost certainly one word: statement 7 should set CONTACTNUMBER3. That is
      the shape your VC CVM script uses — cell1 to CONTACTNUMBER1, cell2 to
      CONTACTNUMBER2, cell3 to CONTACTNUMBER3. Section 3b counts how many
      numbers are being thrown away.

   C. SUBSTRING(CELL1, 4, 10) MAY BE OFF BY ONE, AND WOULD WRITE SHORT NUMBERS.

      Statement 1 reads RPC1 from position 3. Statements 3, 6 and 7 read CELL1,
      CELL2 and CELL3 from position 4. Different sources can genuinely differ —
      '27821234567' needs 3, '+27821234567' needs 4 — but your VC CVM post-load
      script uses the SAME view's CELL1 with no substring at all:

          SET CONTACTNUMBER1 = b.CELL1 ... AND LEN(b.CELL1) >= 9

      treating it as an already-local number. Both cannot be right about the
      same column. If CELL1 really is '0821234567', then position 4 gives
      '1234567' and this writes '01234567' — an eight-character number that
      will never connect, into the field the dialler tries next.

      Section 3a settles it in one query. Do not skip it: this is the only one
      of the three that puts bad data in front of an agent rather than merely
      losing good data.

   -----------------------------------------------------------------------------
   TWO MORE, SMALLER

   D. THE NORMALISER RUNS FOURTH, AFTER TWO COMPARISONS AGAINST WHAT IT FIXES.
      Statement 4 shortens any CELLNUMBER longer than 10. Statement 3 has
      already compared CELLNUMBER against a derived CELL1 by then, so a lead
      whose CELLNUMBER arrived in international format is compared in one format
      and stored in another. Statement 5 then finds the duplicate that statement
      3 could not see and nulls CONTACTNUMBER1 — which, per A, silently disables
      6 and 7 for that row too. Statement 4 belongs first.

   E. VW_DEMOGRAPHIC_TELEPHONE MAY HOLD SEVERAL ROWS PER ID.
      An UPDATE ... FROM matching more than one source row takes one of them and
      Snowflake does not say which, so the number a lead gets is not repeatable
      between runs. Section 3d checks.

   F. STATEMENT 4 ONLY NORMALISES ONE FORMAT, AND WORSENS THE OTHERS.
      CONCAT('0', SUBSTRING(CELLNUMBER, 3, 10)) on anything longer than 10
      characters. Worked through:

          stored value      len   result        len
          27821234567        11   0821234567     10   correct
          +27821234567       12   07821234567    11   still too long, now wrong
          0027821234567      13   02782123456    11   still too long, now wrong

      Only the 11-character '27…' form comes out right. A leading '+' or an
      international '00' prefix produces an eleven-character number that is
      neither the original nor valid, and the statement runs once so nothing
      catches it. LENGTH = 11 AND LEFT(CELLNUMBER, 2) = '27' would say what is
      actually meant; a general fix wants
      CONCAT('0', RIGHT(REGEXP_REPLACE(CELLNUMBER, '[^0-9]', ''), 9))
      which handles every one of those and is idempotent.

      SAME ARITHMETIC IS WHY C MATTERS. Position 3 is correct only for
      '27821234567'; position 4 only for '+27821234567'; for an already-local
      '0821234567' neither works — position 4 yields '01234567', eight
      characters. Section 3a tells you which format you actually have.

   I have changed none of the six. Each one moves which numbers get called, and
   that is your decision, not a translation. Tell me which and they are small
   edits.
============================================================================= */


/* -----------------------------------------------------------------------------
   SECTION 1 — the procedure
-------------------------------------------------------------------------------- */

CREATE OR REPLACE PROCEDURE
    DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_HLL_RPC_CONTACT_NUMBERS(
        CAMPAIGN_ID NUMBER(38,0),
        RPC_MONTHS  NUMBER(38,0)
    )
RETURNS VARCHAR(16777216)
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
    n_rpc_contact NUMBER DEFAULT 0;
    n_rpc_cell    NUMBER DEFAULT 0;
    n_cell1       NUMBER DEFAULT 0;
    n_normalise   NUMBER DEFAULT 0;
    n_dedupe      NUMBER DEFAULT 0;
    n_cell2       NUMBER DEFAULT 0;
    n_cell3       NUMBER DEFAULT 0;
    msg           VARCHAR DEFAULT '';
BEGIN

    -- 1. Copy CELLNUMBER into CONTACTNUMBER1 where it already matches a recent
    --    RPC number. Note A: this fires only when the two are the same number.
    UPDATE DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED h
       SET h.CONTACTNUMBER1 = h.CELLNUMBER
      FROM DATAWAREHOUSE.DISTRIBUTION.VW_YAXXA_RPC_CONTACTNUMBERS c
     WHERE c.IDNO = h.IDNUMBER
       AND c.RPC1_CALL_DATE > DATEADD('MONTH', -1 * :RPC_MONTHS, CURRENT_DATE())
       AND h.CELLNUMBER = CONCAT('0', SUBSTRING(c.RPC1, 3, 10))
       AND h.CAMPAIGNID = :CAMPAIGN_ID
       AND CAST(h.CREATEDONDATE AS DATE) = CURRENT_DATE()
       AND h.ESTATUS IS NULL;
    n_rpc_contact := SQLROWCOUNT;

    -- 2. Put the international form into CELLNUMBER. Statement 4 converts it
    --    straight back — the other half of the round trip in note A.
    UPDATE DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED h
       SET h.CELLNUMBER = c.RPC1
      FROM DATAWAREHOUSE.DISTRIBUTION.VW_YAXXA_RPC_CONTACTNUMBERS c
     WHERE c.IDNO = h.IDNUMBER
       AND c.RPC1_CALL_DATE > DATEADD('MONTH', -1 * :RPC_MONTHS, CURRENT_DATE())
       AND h.CELLNUMBER = CONCAT('0', SUBSTRING(c.RPC1, 3, 10))
       AND h.CAMPAIGNID = :CAMPAIGN_ID
       AND CAST(h.CREATEDONDATE AS DATE) = CURRENT_DATE()
       AND h.ESTATUS IS NULL;
    n_rpc_cell := SQLROWCOUNT;

    -- 3. CONTACTNUMBER1 from CELL1. Position 4 — see note C.
    UPDATE DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED h
       SET h.CONTACTNUMBER1 = CONCAT('0', SUBSTRING(c.CELL1, 4, 10))
      FROM DATAWAREHOUSE.DW_XDS.VW_DEMOGRAPHIC_TELEPHONE c
     WHERE c.IDENTIFIERNUMBER = h.IDNUMBER
       AND h.CELLNUMBER <> CONCAT('0', SUBSTRING(c.CELL1, 4, 10))
       AND h.CAMPAIGNID = :CAMPAIGN_ID
       AND CAST(h.CREATEDONDATE AS DATE) = CURRENT_DATE()
       AND h.ESTATUS IS NULL
       AND h.CONTACTNUMBER1 IS NULL;
    n_cell1 := SQLROWCOUNT;

    -- 4. Normalise an over-long CELLNUMBER to local format. Note D: statement 3
    --    has already compared against the un-normalised value. Note F: correct
    --    only for the 11-character '27…' form.
    UPDATE DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED h
       SET h.CELLNUMBER = CONCAT('0', SUBSTRING(h.CELLNUMBER, 3, 10))
     WHERE LENGTH(h.CELLNUMBER) > 10
       AND h.CAMPAIGNID = :CAMPAIGN_ID
       AND CAST(h.CREATEDONDATE AS DATE) = CURRENT_DATE()
       AND h.ESTATUS IS NULL;
    n_normalise := SQLROWCOUNT;

    -- 5. A second copy of the primary number is not a second number. Every NULL
    --    this writes disables statements 6 and 7 for that row — note A.
    UPDATE DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED h
       SET h.CONTACTNUMBER1 = NULL
     WHERE h.CELLNUMBER = h.CONTACTNUMBER1
       AND h.CAMPAIGNID = :CAMPAIGN_ID
       AND CAST(h.CREATEDONDATE AS DATE) = CURRENT_DATE()
       AND h.ESTATUS IS NULL;
    n_dedupe := SQLROWCOUNT;

    -- 6. CONTACTNUMBER2 from CELL2.
    UPDATE DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED h
       SET h.CONTACTNUMBER2 = CONCAT('0', SUBSTRING(c.CELL2, 4, 10))
      FROM DATAWAREHOUSE.DW_XDS.VW_DEMOGRAPHIC_TELEPHONE c
     WHERE c.IDENTIFIERNUMBER = h.IDNUMBER
       AND h.CELLNUMBER      <> CONCAT('0', SUBSTRING(c.CELL2, 4, 10))
       AND h.CONTACTNUMBER1  <> CONCAT('0', SUBSTRING(c.CELL2, 4, 10))
       AND h.CAMPAIGNID = :CAMPAIGN_ID
       AND CAST(h.CREATEDONDATE AS DATE) = CURRENT_DATE()
       AND h.ESTATUS IS NULL;
    n_cell2 := SQLROWCOUNT;

    -- 7. CONTACTNUMBER2 from CELL3 — overwriting statement 6. Note B: this is
    --    almost certainly meant to be CONTACTNUMBER3. Left as written.
    UPDATE DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED h
       SET h.CONTACTNUMBER2 = CONCAT('0', SUBSTRING(c.CELL3, 4, 10))
      FROM DATAWAREHOUSE.DW_XDS.VW_DEMOGRAPHIC_TELEPHONE c
     WHERE c.IDENTIFIERNUMBER = h.IDNUMBER
       AND h.CELLNUMBER      <> CONCAT('0', SUBSTRING(c.CELL3, 4, 10))
       AND h.CONTACTNUMBER1  <> CONCAT('0', SUBSTRING(c.CELL3, 4, 10))
       AND h.CONTACTNUMBER2  <> CONCAT('0', SUBSTRING(c.CELL3, 4, 10))
       AND h.CAMPAIGNID = :CAMPAIGN_ID
       AND CAST(h.CREATEDONDATE AS DATE) = CURRENT_DATE()
       AND h.ESTATUS IS NULL;
    n_cell3 := SQLROWCOUNT;

    msg := 'HLL contact numbers done for campaign ' || CAMPAIGN_ID
        || ' — rpc→contact1 '   || n_rpc_contact
        || ' | rpc→cell '        || n_rpc_cell
        || ' | cell1→contact1 '  || n_cell1
        || ' | cellnumber normalised ' || n_normalise
        || ' | duplicate contact1 cleared ' || n_dedupe
        || ' | cell2→contact2 '  || n_cell2
        || ' | cell3→contact2 '  || n_cell3;

    RETURN msg;

END;
$$;


/* -----------------------------------------------------------------------------
   SECTION 2 — grants

   CREATE OR REPLACE PROCEDURE drops its grants and has no COPY GRANTS clause,
   so re-run this line every time you replace the procedure.
-------------------------------------------------------------------------------- */

GRANT USAGE ON PROCEDURE
  DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_HLL_RPC_CONTACT_NUMBERS(NUMBER, NUMBER)
  TO ROLE SVC_VERCEL_APP_ROLE;

-- The owner role needs SELECT on both sources, beyond the HLL table it updates:
--   DATAWAREHOUSE.DISTRIBUTION.VW_YAXXA_RPC_CONTACTNUMBERS
--   DATAWAREHOUSE.DW_XDS.VW_DEMOGRAPHIC_TELEPHONE


/* -----------------------------------------------------------------------------
   SECTION 3 — size each finding. 3a first.
-------------------------------------------------------------------------------- */

-- 3a. NOTE C, AND THE ONLY ONE THAT WRITES BAD DATA.
--     What shape are these columns really in? If CELL1 is 10 characters and
--     starts with '0', it is already local and position 4 is wrong by three
--     digits. If it is 11 and starts '27', position 3 is right and 4 is wrong
--     by one. Position 4 is only correct for a 12-character '+27…'.
SELECT 'CELL1' AS COL, LENGTH(CELL1) AS CHARS, LEFT(CELL1, 3) AS STARTS_WITH,
       COUNT(*) AS ROWS_AFFECTED,
       ANY_VALUE(CONCAT('0', SUBSTRING(CELL1, 4, 10))) AS WHAT_THIS_SCRIPT_WRITES,
       ANY_VALUE(CONCAT('0', SUBSTRING(CELL1, 3, 10))) AS WHAT_POSITION_3_WOULD_WRITE
  FROM DATAWAREHOUSE.DW_XDS.VW_DEMOGRAPHIC_TELEPHONE
 WHERE CELL1 IS NOT NULL
 GROUP BY 2, 3
 ORDER BY ROWS_AFFECTED DESC
 LIMIT 20;

-- The same question about RPC1, which this script reads from position 3.
SELECT LENGTH(RPC1) AS CHARS, LEFT(RPC1, 3) AS STARTS_WITH, COUNT(*) AS ROWS_AFFECTED
  FROM DATAWAREHOUSE.DISTRIBUTION.VW_YAXXA_RPC_CONTACTNUMBERS
 WHERE RPC1 IS NOT NULL
 GROUP BY 1, 2
 ORDER BY ROWS_AFFECTED DESC
 LIMIT 20;

-- And what actually landed, after a run. A South African mobile is 10
-- characters starting '0'. Anything else here will not connect.
SELECT LENGTH(CONTACTNUMBER1) AS CHARS, COUNT(*) AS LEADS
  FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED
 WHERE CAMPAIGNID = 11389
   AND CAST(CREATEDONDATE AS DATE) = CURRENT_DATE()
   AND CONTACTNUMBER1 IS NOT NULL
 GROUP BY 1
 ORDER BY CHARS;

-- 3b. NOTE B — how many CELL2 numbers statement 7 throws away. Rows that have
--     both a CELL2 and a different CELL3, so 7 replaces what 6 wrote.
SELECT COUNT(*) AS CELL2_NUMBERS_DISCARDED
  FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED h
  JOIN DATAWAREHOUSE.DW_XDS.VW_DEMOGRAPHIC_TELEPHONE c
    ON c.IDENTIFIERNUMBER = h.IDNUMBER
 WHERE h.CAMPAIGNID = 11389
   AND CAST(h.CREATEDONDATE AS DATE) = CURRENT_DATE()
   AND h.ESTATUS IS NULL
   AND c.CELL2 IS NOT NULL
   AND c.CELL3 IS NOT NULL
   AND c.CELL2 <> c.CELL3;

-- 3c. NOTE A — the RPC round trip, and what it costs. These are the leads
--     statements 1 and 2 touch: a recent right-party contact whose CELLNUMBER
--     is already that number. Every one of them ends with no alternate number.
SELECT COUNT(*) AS RPC_MATCHED_LEADS
  FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED h
  JOIN DATAWAREHOUSE.DISTRIBUTION.VW_YAXXA_RPC_CONTACTNUMBERS c
    ON c.IDNO = h.IDNUMBER
 WHERE h.CAMPAIGNID = 11389
   AND CAST(h.CREATEDONDATE AS DATE) = CURRENT_DATE()
   AND h.ESTATUS IS NULL
   AND c.RPC1_CALL_DATE > DATEADD('MONTH', -3, CURRENT_DATE())
   AND h.CELLNUMBER = CONCAT('0', SUBSTRING(c.RPC1, 3, 10));

-- And the count that matters after a run: eligible leads with nothing to try
-- but the primary number.
SELECT COUNT(*)                                        AS ELIGIBLE_LEADS,
       COUNT_IF(CONTACTNUMBER1 IS NULL
            AND CONTACTNUMBER2 IS NULL
            AND CONTACTNUMBER3 IS NULL)                AS NO_ALTERNATE_NUMBERS,
       COUNT_IF(CONTACTNUMBER1 IS NOT NULL)            AS HAS_CONTACT1,
       COUNT_IF(CONTACTNUMBER2 IS NOT NULL)            AS HAS_CONTACT2,
       COUNT_IF(CONTACTNUMBER3 IS NOT NULL)            AS HAS_CONTACT3
  FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED
 WHERE CAMPAIGNID = 11389
   AND CAST(CREATEDONDATE AS DATE) = CURRENT_DATE()
   AND ESTATUS IS NULL;

-- 3d. NOTE E — does either source view hold more than one row per ID?
SELECT 'VW_DEMOGRAPHIC_TELEPHONE' AS SOURCE, MAX(c) AS MAX_ROWS_PER_ID,
       COUNT(*) AS IDS_WITH_SEVERAL
  FROM (SELECT IDENTIFIERNUMBER, COUNT(*) AS c
          FROM DATAWAREHOUSE.DW_XDS.VW_DEMOGRAPHIC_TELEPHONE
         GROUP BY 1 HAVING COUNT(*) > 1)
UNION ALL
SELECT 'VW_YAXXA_RPC_CONTACTNUMBERS', MAX(c), COUNT(*)
  FROM (SELECT IDNO, COUNT(*) AS c
          FROM DATAWAREHOUSE.DISTRIBUTION.VW_YAXXA_RPC_CONTACTNUMBERS
         GROUP BY 1 HAVING COUNT(*) > 1);
