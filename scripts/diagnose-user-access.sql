/* =============================================================================
   "Why can't this person log in?"
   -----------------------------------------------------------------------------
   Four gates stand between an Azure AD sign-in and the app, and the login screen
   names the one that failed but not the value that failed it. This walks all
   four in order and tells you which is FALSE, then fixes the two that are
   normally the cause.

   THE GATES, in the order lib/auth-gate.ts checks them:

     1. APP_SUPER_ADMINS         a row here bypasses everything below
     2. APP_USER_EMAIL_MAP       AD_EMAIL → EMPLOYEE_EMAIL. MANDATORY.
     3. EMPLOYEE_DETAIL          a row for the MAPPED email, status LIKE 'A%'
     4. APP_ALLOWED_ROLES        contains that row's JOB_TITLE

   GATE 2 IS THE ONE THAT SURPRISES PEOPLE. It is not an override layered on top
   of a direct lookup — it is the ONLY route to the employee table. No map row
   means no login even for someone whose AD address matches HR exactly, and the
   employee table is never queried at all. The message is "Your account is not
   mapped to an employee."

   Departments are a FIFTH thing and not a gate: APP_USER_DEPARTMENTS decides
   what a signed-in person can see. With no rows they sign in successfully and
   the app is empty, because every department-guarded route returns 403. Sign-in
   working and the app being usable are two separate steps.

   -----------------------------------------------------------------------------
   HOW TO USE IT

   Replace the placeholder in section 0 and run the sections in order. Section 1
   is read-only and is the diagnosis; sections 3 and 4 write.

   POPIA. Section 2 returns names, email addresses and job titles. Keep its
   output out of tickets, chat and screenshots — read it, act on it, close it.
============================================================================= */


/* -----------------------------------------------------------------------------
   SECTION 0 — the address to investigate

   THE AD ADDRESS, NOT THE HR ONE. It is what Azure puts in the token, which the
   app reads as `preferred_username || email` — for most people the UPN they
   sign in with, which is NOT necessarily the address on their business card or
   the one HR holds.

   IF YOU DO NOT KNOW WHICH ADDRESS THEY SIGN IN WITH, ASK THEM TO TRY. The
   login screen now prints the address the app received, in monospace, under
   "Ask an administrator to map the address below". That is the value to paste
   here, and it beats guessing between domains.
-------------------------------------------------------------------------------- */

SET AD_EMAIL = 'firstname.lastname@ignitiongroup.co.za';   -- ← the AD address


/* -----------------------------------------------------------------------------
   SECTION 1 — which gate fails?

   One row per gate. READ DOWN THE LIST AND STOP AT THE FIRST 'NO' — that is the
   answer, because the gates are sequential and a later one is not even reached.

   Everything is lower-cased on both sides, matching the app: it normalises with
   trim().toLowerCase() before every one of these lookups.
-------------------------------------------------------------------------------- */

WITH AD AS (SELECT LOWER(TRIM($AD_EMAIL)) AS E),
MAPPED AS (
    SELECT LOWER(TRIM(m.EMPLOYEE_EMAIL)) AS EMPLOYEE_EMAIL
      FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.APP_USER_EMAIL_MAP m, AD
     WHERE LOWER(m.AD_EMAIL) = AD.E
     LIMIT 1
)
SELECT 1 AS GATE, 'super admin (bypasses everything below)'        AS CHECK_NAME,
       IFF(EXISTS (SELECT 1 FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.APP_SUPER_ADMINS s, AD
                    WHERE LOWER(s.AD_EMAIL) = AD.E), 'YES', 'no')  AS RESULT,
       NULL                                                        AS VALUE_FOUND
UNION ALL
SELECT 2, 'mapped to an employee email (MANDATORY)',
       IFF(EXISTS (SELECT 1 FROM MAPPED), 'YES', 'NO  <-- this is "unmapped"'),
       (SELECT EMPLOYEE_EMAIL FROM MAPPED)
UNION ALL
SELECT 3, 'employee record exists for the mapped email',
       IFF(EXISTS (SELECT 1
                     FROM DATAWAREHOUSE.HR_SAGE_DATA.EMPLOYEE_DETAIL e, MAPPED
                    WHERE LOWER(e.EMAIL_ADDRESS) = MAPPED.EMPLOYEE_EMAIL),
           'YES', 'NO  <-- "no_employee"'),
       NULL
UNION ALL
SELECT 4, 'that employee record is active (status LIKE ''A%'')',
       IFF(EXISTS (SELECT 1
                     FROM DATAWAREHOUSE.HR_SAGE_DATA.EMPLOYEE_DETAIL e, MAPPED
                    WHERE LOWER(e.EMAIL_ADDRESS) = MAPPED.EMPLOYEE_EMAIL
                      AND UPPER(TRIM(e.EMPLOYEE_STATUS_DISPLAY)) LIKE 'A%'),
           'YES', 'NO  <-- "inactive"'),
       (SELECT LISTAGG(DISTINCT e.EMPLOYEE_STATUS_DISPLAY, ' | ')
          FROM DATAWAREHOUSE.HR_SAGE_DATA.EMPLOYEE_DETAIL e, MAPPED
         WHERE LOWER(e.EMAIL_ADDRESS) = MAPPED.EMPLOYEE_EMAIL)
UNION ALL
SELECT 5, 'their job title is in APP_ALLOWED_ROLES',
       IFF(EXISTS (SELECT 1
                     FROM DATAWAREHOUSE.HR_SAGE_DATA.EMPLOYEE_DETAIL e
                     JOIN MAPPED ON LOWER(e.EMAIL_ADDRESS) = MAPPED.EMPLOYEE_EMAIL
                     JOIN DATAWAREHOUSE.LEADS_DISTRIBUTION.APP_ALLOWED_ROLES r
                       ON UPPER(TRIM(r.ROLE)) = UPPER(TRIM(e.JOB_TITLE))
                    WHERE UPPER(TRIM(e.EMPLOYEE_STATUS_DISPLAY)) LIKE 'A%'),
           'YES', 'NO  <-- "role_not_allowed"'),
       (SELECT LISTAGG(DISTINCT e.JOB_TITLE, ' | ')
          FROM DATAWAREHOUSE.HR_SAGE_DATA.EMPLOYEE_DETAIL e, MAPPED
         WHERE LOWER(e.EMAIL_ADDRESS) = MAPPED.EMPLOYEE_EMAIL
           AND UPPER(TRIM(e.EMPLOYEE_STATUS_DISPLAY)) LIKE 'A%')
UNION ALL
SELECT 6, 'NOT a gate — departments they can see once in',
       IFF(EXISTS (SELECT 1 FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.APP_USER_DEPARTMENTS d, AD
                    WHERE LOWER(d.AD_EMAIL) = AD.E), 'YES', 'none - app will be empty'),
       (SELECT LISTAGG(d.DEPARTMENT, ', ')
          FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.APP_USER_DEPARTMENTS d, AD
         WHERE LOWER(d.AD_EMAIL) = AD.E)
ORDER BY GATE;

/* VALUE_FOUND ON GATES 2, 4 AND 5 IS WHERE THE USEFUL DETAIL IS. Gate 4 lists
   every status on file for that person — an employee often has a Terminated row
   alongside an Active one, which is why the app filters on the status rather
   than trusting whichever row comes back first. Gate 5 gives the exact job
   title string you would have to allow. */


/* -----------------------------------------------------------------------------
   SECTION 2 — find the HR record, when the AD address is not in EMPLOYEE_DETAIL

   Gate 2 said NO and you need the employee email to map TO. Search by surname:
   the AD address and the HR address can be on different domains entirely, so
   searching by address is exactly what does not work here.

   Pick the row whose EMPLOYEE_STATUS_DISPLAY starts with 'A'. If there are
   several people with the surname, the job title and status will tell them
   apart — do not guess.
-------------------------------------------------------------------------------- */

SET SURNAME = 'lastname';                                  -- ← surname, or part of it

SELECT EMAIL_ADDRESS,
       JOB_TITLE,
       EMPLOYEE_STATUS_DISPLAY,
       IFF(UPPER(TRIM(EMPLOYEE_STATUS_DISPLAY)) LIKE 'A%', 'active', '') AS USABLE
  FROM DATAWAREHOUSE.HR_SAGE_DATA.EMPLOYEE_DETAIL
 WHERE LOWER(EMAIL_ADDRESS) LIKE '%' || LOWER($SURNAME) || '%'
 ORDER BY USABLE DESC, EMAIL_ADDRESS
 LIMIT 50;

/* IF THAT RETURNS NOTHING, the address is not the search key you need — the HR
   address may not contain their surname at all. The app's own employee search
   box (Settings → Map user) also searches the NAME columns, whose names differ
   between environments and are probed at runtime. Use that screen instead of
   guessing column names here; it is the same data. */


/* -----------------------------------------------------------------------------
   SECTION 3 — add the map rows

   ONE PERSON CAN HAVE SEVERAL AD ADDRESSES POINTING AT ONE EMPLOYEE RECORD.
   The map is keyed on AD_EMAIL, so listing every plausible address is not a
   hack — it is the intended shape, and it means you do not have to know which
   claim their token carries. The unused rows are inert.

   The MERGE mirrors app/api/admin/email-map/route.ts, so this and the Settings
   → Map user screen do exactly the same thing and either is safe to re-run.

   The Settings screen is the better choice for one address, because it refuses
   to save unless it finds the HR record — a typo in the employee email is
   caught there and not here.
-------------------------------------------------------------------------------- */

SET EMPLOYEE_EMAIL = 'firstname.lastname@theirhrdomain.com';   -- ← from section 2

MERGE INTO DATAWAREHOUSE.LEADS_DISTRIBUTION.APP_USER_EMAIL_MAP t
USING (
    -- Every AD address this person might sign in with. Delete the lines that
    -- do not apply; a wrong one costs nothing but is noise in the table.
              SELECT 'firstname.lastname@ignitiongroup.co.za' AS AD_EMAIL
    UNION ALL SELECT 'firstname.lastname@spot.co.za'
    UNION ALL SELECT 'networkid@ignitiongroup.co.za'
) s
   ON LOWER(t.AD_EMAIL) = LOWER(s.AD_EMAIL)
 WHEN MATCHED THEN
      UPDATE SET EMPLOYEE_EMAIL = LOWER(TRIM($EMPLOYEE_EMAIL))
 WHEN NOT MATCHED THEN
      INSERT (AD_EMAIL, EMPLOYEE_EMAIL, CREATED_BY)
      VALUES (LOWER(TRIM(s.AD_EMAIL)), LOWER(TRIM($EMPLOYEE_EMAIL)), CURRENT_USER());

-- Confirm, then go back and re-run section 1.
SELECT AD_EMAIL, EMPLOYEE_EMAIL, CREATED_AT, CREATED_BY
  FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.APP_USER_EMAIL_MAP
 WHERE LOWER(EMPLOYEE_EMAIL) = LOWER(TRIM($EMPLOYEE_EMAIL))
 ORDER BY AD_EMAIL;


/* -----------------------------------------------------------------------------
   SECTION 4 — the role gate, if gate 5 said NO

   STOP AND THINK BEFORE RUNNING THE INSERT. Every other section in this file
   affects one person. This one does not: APP_ALLOWED_ROLES is keyed on JOB
   TITLE, so allowing "Financial Manager" admits EVERY active employee holding
   that title, now and in future, the moment someone maps them.

   That is often the right answer — the table exists to grant access by role.
   But it is an access decision about a group, so it belongs to whoever owns
   that, not to whoever is unblocking one person on a Friday afternoon.
-------------------------------------------------------------------------------- */

-- 4a. What is allowed today.
SELECT ROLE
  FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.APP_ALLOWED_ROLES
 ORDER BY ROLE;

-- 4b. How many active employees a new title would let in, before you add it.
--     Only those with a map row can actually sign in today, so both numbers
--     matter: the first is the immediate effect, the second the eventual one.
SET JOB_TITLE = 'Financial Manager';                       -- ← from section 1, gate 5

SELECT COUNT(*)                                            AS ACTIVE_WITH_THIS_TITLE,
       COUNT_IF(EXISTS (
         SELECT 1 FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.APP_USER_EMAIL_MAP m
          WHERE LOWER(m.EMPLOYEE_EMAIL) = LOWER(e.EMAIL_ADDRESS)))
                                                           AS AND_ALREADY_MAPPED
  FROM DATAWAREHOUSE.HR_SAGE_DATA.EMPLOYEE_DETAIL e
 WHERE UPPER(TRIM(e.JOB_TITLE)) = UPPER(TRIM($JOB_TITLE))
   AND UPPER(TRIM(e.EMPLOYEE_STATUS_DISPLAY)) LIKE 'A%';

-- 4c. Add it. Guarded so a re-run is a no-op.
INSERT INTO DATAWAREHOUSE.LEADS_DISTRIBUTION.APP_ALLOWED_ROLES (ROLE)
SELECT TRIM($JOB_TITLE)
 WHERE NOT EXISTS (
   SELECT 1 FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.APP_ALLOWED_ROLES
    WHERE UPPER(TRIM(ROLE)) = UPPER(TRIM($JOB_TITLE)));


/* -----------------------------------------------------------------------------
   SECTION 5 — who else would be blocked?

   The people who would hit gate 2 the moment they try: active employees whose
   job title is already allowed, but who have no map row. Every one of them will
   get "not mapped to an employee" on their first sign-in.

   A short list means the mapping is being kept up. A long one means new joiners
   are not being mapped as they arrive, and this stops being a per-person
   problem and starts being a process one.

   NAMES AND ADDRESSES — POPIA. Read it, act on it, close it.
-------------------------------------------------------------------------------- */

SELECT e.EMAIL_ADDRESS,
       e.JOB_TITLE
  FROM DATAWAREHOUSE.HR_SAGE_DATA.EMPLOYEE_DETAIL e
  JOIN DATAWAREHOUSE.LEADS_DISTRIBUTION.APP_ALLOWED_ROLES r
    ON UPPER(TRIM(r.ROLE)) = UPPER(TRIM(e.JOB_TITLE))
 WHERE UPPER(TRIM(e.EMPLOYEE_STATUS_DISPLAY)) LIKE 'A%'
   AND NOT EXISTS (
         SELECT 1 FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.APP_USER_EMAIL_MAP m
          WHERE LOWER(m.EMPLOYEE_EMAIL) = LOWER(e.EMAIL_ADDRESS))
 ORDER BY e.JOB_TITLE, e.EMAIL_ADDRESS;

-- 5b. And the reverse — map rows pointing at an employee who is no longer
--     active, or at no employee at all. These people cannot sign in either, but
--     the reason is 'inactive'/'no_employee' rather than 'unmapped', and a
--     leaver's stale row is worth clearing rather than leaving to rot.
SELECT m.AD_EMAIL,
       m.EMPLOYEE_EMAIL,
       IFNULL(e.EMPLOYEE_STATUS_DISPLAY, '(no employee record)') AS STATUS
  FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.APP_USER_EMAIL_MAP m
  LEFT JOIN DATAWAREHOUSE.HR_SAGE_DATA.EMPLOYEE_DETAIL e
    ON LOWER(e.EMAIL_ADDRESS) = LOWER(m.EMPLOYEE_EMAIL)
   AND UPPER(TRIM(e.EMPLOYEE_STATUS_DISPLAY)) LIKE 'A%'
 WHERE e.EMAIL_ADDRESS IS NULL
 ORDER BY m.AD_EMAIL;


/* -----------------------------------------------------------------------------
   SECTION 6 — after they are in

   1. Have them sign in. If it still fails, the login screen now prints the
      address the app received — paste THAT into section 0 and re-run section 1.
   2. Assign departments in Settings → the user-departments screen. Until then
      they sign in fine and the app is empty; that is not a new fault, and it is
      the single most common "the fix didn't work" report.
   3. A SIGNED-IN SESSION LASTS 10 HOURS AND IS NOT RE-CHECKED against these
      gates. Removing a map row or a role does not sign anyone out — it stops
      the NEXT sign-in. Plan offboarding accordingly.
-------------------------------------------------------------------------------- */
