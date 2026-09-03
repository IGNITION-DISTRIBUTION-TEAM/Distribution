/* =============================================================================
   TASK AUTOMATION — endpoint registry and the one procedure the app calls
   -----------------------------------------------------------------------------
   Run 00-grants.sql first, then this, as ACCOUNTADMIN.

   This replaces the first cut of this file, which hard-coded host, port, user,
   host key, browse root and caps as Python constants inside two near-identical
   procedures. Two things were wrong with that. Changing a cap meant
   CREATE OR REPLACE, which drops grants — a cost already paid twice this week.
   And the connection block was duplicated, with a comment telling you to
   remember to edit both copies.

   Config now lives in a table. The app passes an ENDPOINT NAME and a path;
   everything else is looked up server-side.

   -----------------------------------------------------------------------------
   WHY HOST AND HOST KEY ARE NOT PARAMETERS

   They were the obvious things to pass, and passing them would be a security
   regression rather than a cleanup.

   Host-key pinning only means anything if the pin does not come from whoever
   supplies the host. Accept both from the caller and a bug — or a crafted
   call — points this procedure at an arbitrary server AND tells it to trust
   that server's key. It then authenticates to that server with the real
   private key. The key is exfiltrated, and every log line says SUCCESS.

   So the host and its pin live in the same row, server-side, written only by
   someone who can already reach the secret. That is the only party who should
   be deciding what the secret gets sent to.

   Two more things cannot be parameters even in principle: SECRETS and
   EXTERNAL_ACCESS_INTEGRATIONS are DDL clauses, not runtime arguments. A
   procedure serving several endpoints must declare every secret it might use in
   its own definition, and the EAI must already allow every host's network rule.
   The registry row selects WHICH declared binding to use, by name.
============================================================================= */


/* -----------------------------------------------------------------------------
   SECTION 1 — the admin schema

   Separate from SPOT_SFTP on purpose. 00-grants.sql section 6 grants the app
   SELECT/INSERT/UPDATE/DELETE ON FUTURE TABLES IN SCHEMA SPOT_DW.SPOT_SFTP, so
   a registry created there would be handed over automatically the moment it
   existed. The app gets USAGE here and SELECT on one secure view, nothing else.
-------------------------------------------------------------------------------- */

CREATE SCHEMA IF NOT EXISTS SPOT_DW.SFTP_ADMIN
  COMMENT = 'SFTP endpoint registry. The app reads VW_SFTP_ENDPOINTS_APP only; '
            'it must never hold a privilege on SFTP_ENDPOINTS itself.';


/* -----------------------------------------------------------------------------
   SECTION 2 — the registry
-------------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS SPOT_DW.SFTP_ADMIN.SFTP_ENDPOINTS (
    ENDPOINT_NAME           VARCHAR(64)   NOT NULL
                            COMMENT 'Short key the app passes, e.g. SPOT',
    LABEL                   VARCHAR(200)
                            COMMENT 'Shown in the UI',

    HOST                    VARCHAR(255)  NOT NULL,
    PORT                    NUMBER(5,0)   NOT NULL DEFAULT 22,
    SFTP_USER               VARCHAR(128)  NOT NULL,

    HOST_KEY_TYPE           VARCHAR(64)   NOT NULL
                            COMMENT 'ssh-rsa, ssh-ed25519, ecdsa-sha2-nistp256',
    HOST_KEY_B64            VARCHAR(4096) NOT NULL
                            COMMENT 'The pin. Same row as the host it pins, and never caller-supplied.',

    SECRET_KEY_NAME         VARCHAR(64)   NOT NULL DEFAULT 'pkey'
                            COMMENT 'WHICH of the procedure''s declared SECRETS bindings holds the private key',
    SECRET_PASSPHRASE_NAME  VARCHAR(64)            DEFAULT 'passphrase'
                            COMMENT 'Binding name for the passphrase, or NULL if the key has none',

    ALLOWED_ROOT            VARCHAR(512)  NOT NULL
                            COMMENT 'Browse and peek confined to this subtree. Must not be /',

    MAX_ENTRIES             NUMBER(10,0)  NOT NULL DEFAULT 500,
    MAX_PEEK_LINES          NUMBER(10,0)  NOT NULL DEFAULT 50,
    MAX_PEEK_BYTES          NUMBER(12,0)  NOT NULL DEFAULT 1048576,

    ENABLED                 BOOLEAN       NOT NULL DEFAULT TRUE,

    NOTES                   VARCHAR(1000),
    CREATED_AT              TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    CREATED_BY              VARCHAR(255)  DEFAULT CURRENT_USER(),

    CONSTRAINT PK_SFTP_ENDPOINTS PRIMARY KEY (ENDPOINT_NAME)
);

/* THAT PRIMARY KEY IS NOT ENFORCED. Snowflake accepts PRIMARY KEY, UNIQUE and
   FOREIGN KEY as metadata and does not enforce any of them — you can insert the
   same ENDPOINT_NAME twice. Every rule that actually matters is therefore
   checked in the procedure: unknown endpoint, disabled endpoint, ALLOWED_ROOT
   of '/' or blank, empty HOST_KEY_B64, and more than one row for a name.

   Worth knowing beyond this file: the same is true of the standards document's
   `primary key (_FILE, _LINE)`. It does not prevent duplicate rows. The
   idempotency of those syncs comes entirely from the MERGE, not from the key. */


/* -----------------------------------------------------------------------------
   SECTION 3 — what the app is allowed to see

   Name, label, root, enabled. No host, no user, no key, no caps. SECURE so the
   definition is hidden from GET_DDL as well.
-------------------------------------------------------------------------------- */

CREATE OR REPLACE SECURE VIEW SPOT_DW.SFTP_ADMIN.VW_SFTP_ENDPOINTS_APP
COPY GRANTS
COMMENT = 'Endpoint list for the Task Automation UI. Deliberately excludes HOST, '
          'SFTP_USER and HOST_KEY_B64 — the app has no business reading those.'
AS
SELECT ENDPOINT_NAME,
       LABEL,
       ALLOWED_ROOT,
       ENABLED
  FROM SPOT_DW.SFTP_ADMIN.SFTP_ENDPOINTS
 WHERE ENABLED = TRUE;


/* -----------------------------------------------------------------------------
   SECTION 4 — register the Spot endpoint

   PASTE THE REAL HOST KEY. It was redacted from the working procedure you sent,
   and I have not invented a placeholder that looks plausible — HOST_KEY_B64 is
   NOT NULL and the procedure refuses to connect on a blank value, so a
   forgotten paste fails loudly instead of quietly disabling verification.

   Get it from the working procedure:
     SELECT GET_DDL('PROCEDURE',
       'SP_SPOT_SFTP_INGEST(STRING, STRING, STRING, STRING, BOOLEAN)');
-------------------------------------------------------------------------------- */

INSERT INTO SPOT_DW.SFTP_ADMIN.SFTP_ENDPOINTS (
    ENDPOINT_NAME, LABEL, HOST, PORT, SFTP_USER,
    HOST_KEY_TYPE, HOST_KEY_B64,
    SECRET_KEY_NAME, SECRET_PASSPHRASE_NAME,
    ALLOWED_ROOT, NOTES
)
SELECT
    'SPOT',
    'Spot (securetransfer.spotplatformapi.com)',
    'securetransfer.spotplatformapi.com',
    22,
    'ignition_snowflake_sync',
    'ssh-rsa',
    '<<PASTE_HOST_KEY_B64_HERE>>',
    'pkey',
    'passphrase',
    '/spot_money',
    'Host key captured via ssh-keyscan 2026-08-11. Verify with Spot before '
    'treating the feed as trusted. Root confined to /spot_money: everything in '
    'the standards doc and the working script sits under it.'
WHERE NOT EXISTS (
    SELECT 1 FROM SPOT_DW.SFTP_ADMIN.SFTP_ENDPOINTS WHERE ENDPOINT_NAME = 'SPOT'
);

/* The NOT EXISTS makes this file safe to re-run — necessary because the PRIMARY
   KEY above will not stop a second insert. */


/* -----------------------------------------------------------------------------
   SECTION 5 — the one procedure the app calls

   ACTION = 'list'  → directory entries, for browsing to a file
   ACTION = 'peek'  → the first N raw lines, so the column mapper has a header

   Raw lines, not parsed fields: delimiter sniffing belongs in the app where the
   operator can see the guess and correct it. A procedure guessing silently is
   how you get a one-column table.

   OWNED BY ACCOUNTADMIN, EXECUTE AS OWNER — so the body reads the registry and
   the secrets as ACCOUNTADMIN while the app holds nothing but USAGE. This is
   the one place the app is not the owner, and it is what lets the app browse
   without ever holding a privilege that could read a host key.
-------------------------------------------------------------------------------- */

CREATE OR REPLACE PROCEDURE SPOT_DW.SFTP_ADMIN.SP_SFTP_INSPECT(
    ENDPOINT    STRING,
    REMOTE_PATH STRING,
    ACTION      STRING,
    MAX_ROWS    NUMBER
)
RETURNS VARIANT
LANGUAGE PYTHON
RUNTIME_VERSION = '3.11'
PACKAGES = ('snowflake-snowpark-python', 'paramiko')
HANDLER = 'run'
EXTERNAL_ACCESS_INTEGRATIONS = (SPOT_SFTP_ACCESS)
SECRETS = ('pkey' = SPOT_SFTP_PRIVATE_KEY, 'passphrase' = SPOT_SFTP_KEY_PASSPHRASE)
EXECUTE AS OWNER
AS
$$
import base64
import io
import posixpath
import re
import stat as statmod
import traceback

import paramiko
import _snowflake

REGISTRY = 'SPOT_DW.SFTP_ADMIN.SFTP_ENDPOINTS'

# Paramiko class per host key type. Anything not listed is refused rather than
# guessed — trusting a key we cannot parse correctly is worse than failing.
KEY_CLASSES = {
    'ssh-rsa': paramiko.RSAKey,
    'ssh-ed25519': paramiko.Ed25519Key,
    'ecdsa-sha2-nistp256': paramiko.ECDSAKey,
    'ecdsa-sha2-nistp384': paramiko.ECDSAKey,
    'ecdsa-sha2-nistp521': paramiko.ECDSAKey,
}


def _endpoint(session, name):
    """Load and validate one endpoint row. Every guard that matters is here,
    because Snowflake does not enforce the table's constraints."""
    n = (name or '').strip().upper()
    if not n or not re.match(r'^[A-Z0-9_]+$', n):
        raise ValueError(
            'Endpoint name {!r} is not a plain identifier.'.format(name)
        )

    rows = session.sql(
        'SELECT HOST, PORT, SFTP_USER, HOST_KEY_TYPE, HOST_KEY_B64, '
        '       SECRET_KEY_NAME, SECRET_PASSPHRASE_NAME, ALLOWED_ROOT, '
        '       MAX_ENTRIES, MAX_PEEK_LINES, MAX_PEEK_BYTES, ENABLED '
        '  FROM ' + REGISTRY + ' WHERE UPPER(ENDPOINT_NAME) = ?',
        params=[n],
    ).collect()

    if not rows:
        raise ValueError('No SFTP endpoint registered as {!r}.'.format(n))
    if len(rows) > 1:
        # The PK is metadata only, so this really can happen.
        raise ValueError(
            '{} rows registered for endpoint {!r}. The primary key on '
            'SFTP_ENDPOINTS is not enforced by Snowflake; de-duplicate it '
            'before using this endpoint.'.format(len(rows), n)
        )

    r = rows[0].as_dict()
    if not r['ENABLED']:
        raise ValueError('Endpoint {!r} is registered but not ENABLED.'.format(n))

    root = (r['ALLOWED_ROOT'] or '').strip()
    if not root or root == '/':
        raise ValueError(
            'Endpoint {!r} has ALLOWED_ROOT = {!r}. A root of / or blank is not '
            'a boundary; set a real subtree.'.format(n, root)
        )
    if not (r['HOST_KEY_B64'] or '').strip():
        raise ValueError(
            'Endpoint {!r} has no HOST_KEY_B64. Refusing to connect without '
            'host key verification.'.format(n)
        )
    if r['HOST_KEY_TYPE'] not in KEY_CLASSES:
        raise ValueError(
            'Endpoint {!r} has HOST_KEY_TYPE {!r}, which this procedure does '
            'not know how to parse. Known types: {}.'
            .format(n, r['HOST_KEY_TYPE'], ', '.join(sorted(KEY_CLASSES)))
        )

    r['ALLOWED_ROOT'] = root
    r['ENDPOINT_NAME'] = n
    return r


def _safe_path(raw, root, default_root):
    """Resolve a path and require it to sit under root.

    THE ROOT CHECK IS THE CONTROL, not a test for '..'. posixpath.normpath
    CLAMPS at root, so '/a/../../etc' normalises to '/etc' with no '..' left in
    it — a '..' test applied after normalising is dead code and passes that
    path. Duplicate slashes are collapsed first because normpath preserves a
    leading '//', which would then fail the prefix comparison.

    The prefix is compared WITH a trailing slash: without it, '/spot_money_x'
    would pass a root of '/spot_money'.
    """
    p = (raw or '').strip()
    if not p:
        if not default_root:
            raise ValueError('No file path given.')
        p = root
    if not p.startswith('/'):
        p = '/' + p
    p = re.sub(r'/{2,}', '/', p)
    p = posixpath.normpath(p)

    r = re.sub(r'/{2,}', '/', posixpath.normpath(root))
    if p != r and not p.startswith(r.rstrip('/') + '/'):
        raise ValueError(
            'Refusing {!r}: resolves to {!r}, outside the permitted root {!r}.'
            .format(raw, p, r)
        )
    return p


def _load_private_key(ep):
    material = _snowflake.get_generic_secret_string(ep['SECRET_KEY_NAME'])
    passphrase = None
    if ep['SECRET_PASSPHRASE_NAME']:
        try:
            passphrase = _snowflake.get_generic_secret_string(
                ep['SECRET_PASSPHRASE_NAME']) or None
        except Exception:
            passphrase = None

    last = None
    for cls in (paramiko.Ed25519Key, paramiko.RSAKey, paramiko.ECDSAKey):
        try:
            return cls.from_private_key(io.StringIO(material), password=passphrase)
        except paramiko.SSHException as exc:
            last = exc
    raise RuntimeError(
        'Could not load the private key from secret binding {!r}. Check the '
        'full key including BEGIN/END lines is stored and the passphrase '
        'matches. Last error: {}'.format(ep['SECRET_KEY_NAME'], last)
    )


def _connect(ep):
    expected = KEY_CLASSES[ep['HOST_KEY_TYPE']](
        data=base64.b64decode(ep['HOST_KEY_B64'])
    )
    client = paramiko.SSHClient()
    client.get_host_keys().add(ep['HOST'], ep['HOST_KEY_TYPE'], expected)
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    client.connect(
        hostname=ep['HOST'], port=int(ep['PORT']), username=ep['SFTP_USER'],
        pkey=_load_private_key(ep),
        allow_agent=False, look_for_keys=False,
        timeout=60, banner_timeout=60, auth_timeout=60,
    )
    return client


def _clamp(requested, cap, fallback):
    try:
        v = int(requested) if requested is not None else int(fallback)
    except (TypeError, ValueError):
        v = int(fallback)
    return max(1, min(v, int(cap)))


def _list(sftp, path, ep, max_rows):
    limit = _clamp(max_rows, ep['MAX_ENTRIES'], ep['MAX_ENTRIES'])
    entries = sftp.listdir_attr(path)
    rows = []
    for e in entries:
        is_dir = e.st_mode is not None and statmod.S_ISDIR(e.st_mode)
        rows.append({
            'name': e.filename,
            'is_dir': is_dir,
            'size': None if is_dir else e.st_size,
            'mtime_epoch': e.st_mtime,
            'path': posixpath.join(path, e.filename),
        })
    # Directories first, then files, each alphabetically. This is a browser, so
    # a stable readable order beats whatever the server returned.
    rows.sort(key=lambda r: (not r['is_dir'], r['name'].lower()))
    total = len(rows)
    return {
        'entries': rows[:limit],
        'entry_count': total,
        'truncated': total > limit,
    }


def _peek(sftp, path, ep, max_rows):
    want = _clamp(max_rows, ep['MAX_PEEK_LINES'], 20)
    byte_cap = int(ep['MAX_PEEK_BYTES'])

    st = sftp.stat(path)
    if st.st_mode is not None and statmod.S_ISDIR(st.st_mode):
        raise ValueError('{!r} is a directory. Use action = list.'.format(path))

    chunks = []
    read = 0
    with sftp.open(path, 'r') as fh:
        fh.prefetch(min(st.st_size or byte_cap, byte_cap))
        while read < byte_cap:
            block = fh.read(min(65536, byte_cap - read))
            if not block:
                break
            chunks.append(block)
            read += len(block)
            # Stop once enough newlines are in hand. No point reading 200 MB to
            # show 20 lines. Two caps, not one: a "CSV" that turns out to be a
            # single enormous line would never satisfy the line count, so the
            # byte cap is what actually bounds it.
            if b'\n' in block and b''.join(chunks).count(b'\n') > want:
                break

    raw = b''.join(chunks)
    # errors='replace', not 'strict': the point is to show the operator what is
    # in the file. A mis-encoded byte should appear as a visible replacement
    # character, not raise and hide the header row.
    text = raw.decode('utf-8-sig', errors='replace')
    lines = text.splitlines()[:want]
    return {
        'lines': lines,
        'line_count': len(lines),
        'size': st.st_size,
        'mtime_epoch': st.st_mtime,
        'bytes_read': read,
        'byte_capped': read >= byte_cap,
    }


def run(session, endpoint, remote_path, action, max_rows):
    act = (action or 'list').strip().lower()
    result = {
        'status': 'FAILED',
        'action': act,
        'endpoint': None,
        'path': None,
        'error_message': None,
    }
    client = None
    try:
        if act not in ('list', 'peek'):
            raise ValueError(
                'Unknown action {!r}. Use list or peek.'.format(action)
            )

        ep = _endpoint(session, endpoint)
        result['endpoint'] = ep['ENDPOINT_NAME']
        result['allowed_root'] = ep['ALLOWED_ROOT']

        path = _safe_path(remote_path, ep['ALLOWED_ROOT'], default_root=(act == 'list'))
        result['path'] = path

        client = _connect(ep)
        sftp = client.open_sftp()
        try:
            payload = _list(sftp, path, ep, max_rows) if act == 'list' \
                else _peek(sftp, path, ep, max_rows)
        finally:
            sftp.close()

        result.update(payload)
        result['status'] = 'SUCCESS'
        return result

    except Exception as exc:
        result['error_message'] = '{}: {}'.format(type(exc).__name__, exc)
        result['traceback'] = traceback.format_exc()
        return result

    finally:
        if client is not None:
            client.close()
$$;


/* -----------------------------------------------------------------------------
   SECTION 6 — grants

   CREATE OR REPLACE PROCEDURE drops its grants and has no COPY GRANTS clause,
   so THIS LINE MUST BE RE-RUN every time section 5 is replaced. Forgetting
   produces "Unknown user-defined function", which reads as a missing object
   rather than a missing grant, and costs an afternoon.

   (The secure view in section 3 does carry COPY GRANTS, so replacing that one
   keeps its grant.)
-------------------------------------------------------------------------------- */

GRANT USAGE ON PROCEDURE SPOT_DW.SFTP_ADMIN.SP_SFTP_INSPECT(STRING, STRING, STRING, NUMBER)
  TO ROLE SVC_VERCEL_APP_ROLE;


/* -----------------------------------------------------------------------------
   SECTION 7 — smoke test

   The procedure NEVER RAISES. It returns a VARIANT with status = 'SUCCESS' or
   'FAILED' plus an error_message, so a CALL that "worked" tells you nothing.
   Check the status field on every one of these.
-------------------------------------------------------------------------------- */

-- Should succeed and list the Spot tree root.
CALL SPOT_DW.SFTP_ADMIN.SP_SFTP_INSPECT('SPOT', '/spot_money', 'list', 100);

-- Should succeed. Empty path defaults to ALLOWED_ROOT for a listing.
CALL SPOT_DW.SFTP_ADMIN.SP_SFTP_INSPECT('SPOT', '', 'list', 50);

-- Should succeed and normalise to /spot_money/spot_arpu_automation.
CALL SPOT_DW.SFTP_ADMIN.SP_SFTP_INSPECT('SPOT', '//spot_money//spot_arpu_automation//', 'list', 50);

-- Header row for the mapper. Substitute a real filename.
CALL SPOT_DW.SFTP_ADMIN.SP_SFTP_INSPECT(
  'SPOT', '/spot_money/spot_arpu_automation/config_files/rates/<<A_REAL_FILE>>', 'peek', 5);

/* Each of these must come back FAILED, with a DIFFERENT message. If any
   succeeds, the corresponding guard is not doing its job. */
CALL SPOT_DW.SFTP_ADMIN.SP_SFTP_INSPECT('SPOT', '/etc', 'list', 10);                    -- outside root
CALL SPOT_DW.SFTP_ADMIN.SP_SFTP_INSPECT('SPOT', '/spot_money/../../etc', 'list', 10);   -- outside root after normalising
CALL SPOT_DW.SFTP_ADMIN.SP_SFTP_INSPECT('SPOT', '/spot_money_other/x', 'list', 10);     -- prefix-match trap
CALL SPOT_DW.SFTP_ADMIN.SP_SFTP_INSPECT('NOPE', '/spot_money', 'list', 10);             -- unknown endpoint
CALL SPOT_DW.SFTP_ADMIN.SP_SFTP_INSPECT('SPOT', '/spot_money', 'delete', 10);           -- unknown action
CALL SPOT_DW.SFTP_ADMIN.SP_SFTP_INSPECT('SPOT', '/spot_money', 'peek', 5);              -- peek on a directory

-- The app must NOT be able to read the registry directly. Run as the app role:
--   SELECT * FROM SPOT_DW.SFTP_ADMIN.SFTP_ENDPOINTS;         -- expect: refused
--   SELECT * FROM SPOT_DW.SFTP_ADMIN.VW_SFTP_ENDPOINTS_APP;  -- expect: name/label/root/enabled only
--
-- Then confirm the app can see the procedure, which a worksheet cannot tell you:
--   /api/distribution/snowflake-identity?object=SPOT_DW.SFTP_ADMIN.SP_SFTP_INSPECT
