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

/* The app reads VW_SFTP_ENDPOINTS_APP only. It must never hold a privilege on
   SFTP_ENDPOINTS itself — see the note in 00-grants.sql section 4b. */
CREATE SCHEMA IF NOT EXISTS SPOT_DW.SFTP_ADMIN
  COMMENT = 'SFTP endpoint registry. App-readable through the secure view only.';


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

    /* ROOT_FLOOR is the hard boundary: set here, never editable from the app.
       ALLOWED_ROOT is where browsing starts and MAY be narrowed within the
       floor, but never widened past it. Both rules are enforced in
       SP_SFTP_INSPECT and SP_SFTP_ENDPOINT_UPDATE, not by constraints. */
    ROOT_FLOOR              VARCHAR(512)  NOT NULL
                            COMMENT 'Hard boundary. Not app-editable.',
    ALLOWED_ROOT            VARCHAR(512)  NOT NULL
                            COMMENT 'Browse start. App may narrow within ROOT_FLOOR. Never /.',

    MAX_ENTRIES             NUMBER(10,0)  NOT NULL DEFAULT 500,
    MAX_PEEK_LINES          NUMBER(10,0)  NOT NULL DEFAULT 50,
    MAX_PEEK_BYTES          NUMBER(12,0)  NOT NULL DEFAULT 1048576,

    ENABLED                 BOOLEAN       NOT NULL DEFAULT TRUE,

    NOTES                   VARCHAR(1000),
    CREATED_AT              TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    CREATED_BY              VARCHAR(255)  DEFAULT CURRENT_USER(),
    UPDATED_AT              TIMESTAMP_NTZ,
    UPDATED_BY              VARCHAR(255)
                            COMMENT 'App-asserted actor from the last SP_SFTP_ENDPOINT_UPDATE call',

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
COMMENT = 'Endpoint list for the Task Automation UI. Excludes HOST, SFTP_USER and HOST_KEY_B64.'
AS
SELECT ENDPOINT_NAME,
       LABEL,
       ROOT_FLOOR,
       ALLOWED_ROOT,
       MAX_ENTRIES,
       MAX_PEEK_LINES,
       MAX_PEEK_BYTES,
       ENABLED,
       NOTES,
       UPDATED_AT,
       UPDATED_BY
  FROM SPOT_DW.SFTP_ADMIN.SFTP_ENDPOINTS;

/* Note there is NO `WHERE ENABLED = TRUE` here. The settings screen has to be
   able to see a disabled endpoint in order to re-enable it — an earlier version
   filtered them out, which would have made "disable" a one-way door through the
   UI. Callers that only want usable endpoints filter on ENABLED themselves. */


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
    ROOT_FLOOR, ALLOWED_ROOT, NOTES
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
    '/spot_money',   -- ROOT_FLOOR: the hard boundary, not app-editable
    '/spot_money',   -- ALLOWED_ROOT: starting point, app may narrow within the floor
    'Host key captured via ssh-keyscan 2026-08-11. Verify with Spot before treating the feed as trusted. Root confined to /spot_money: everything in the standards doc and the working script sits under it.'
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
        '       SECRET_KEY_NAME, SECRET_PASSPHRASE_NAME, '
        '       ROOT_FLOOR, ALLOWED_ROOT, '
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

    floor = (r['ROOT_FLOOR'] or '').strip()
    root = (r['ALLOWED_ROOT'] or '').strip()
    if not floor or floor == '/':
        raise ValueError(
            'Endpoint {!r} has ROOT_FLOOR = {!r}. A floor of / or blank is not a '
            'boundary; set a real subtree.'.format(n, floor)
        )
    if not root:
        root = floor

    # THE FLOOR IS ENFORCED HERE, ON READ — not only when the app writes.
    # ALLOWED_ROOT is app-editable, so checking it only at write time would mean
    # a direct UPDATE on the table (or a future second writer) could widen the
    # boundary and nothing downstream would notice. Checked here, ROOT_FLOOR is
    # the boundary however ALLOWED_ROOT came to hold its value.
    #
    # Refused rather than silently clamped to the floor: a wider ALLOWED_ROOT
    # means someone misconfigured this endpoint, and quietly narrowing it would
    # hide that while appearing to work.
    f_norm = re.sub(r'/{2,}', '/', posixpath.normpath(floor))
    r_norm = re.sub(r'/{2,}', '/', posixpath.normpath(root))
    if r_norm != f_norm and not r_norm.startswith(f_norm.rstrip('/') + '/'):
        raise ValueError(
            'Endpoint {!r} has ALLOWED_ROOT {!r}, which is outside its '
            'ROOT_FLOOR {!r}. Refusing rather than clamping — fix the row.'
            .format(n, root, floor)
        )
    root = r_norm
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
    r['ROOT_FLOOR'] = f_norm
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
        result['root_floor'] = ep['ROOT_FLOOR']

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
   SECTION 6 — settings the app IS allowed to change

   Snowflake has no column-level UPDATE privilege: GRANT UPDATE ON TABLE grants
   it on every column. So the split between "config" and "where the private key
   gets sent" cannot be expressed with grants at all — it has to be a procedure.
   This one accepts only the editable fields and touches nothing else, and the
   app holds USAGE on it and still no privilege on the table.

   EDITABLE            LABEL, NOTES, the three caps, ENABLED, ALLOWED_ROOT
   NOT EDITABLE, EVER  HOST, PORT, SFTP_USER, HOST_KEY_TYPE, HOST_KEY_B64,
                       SECRET_KEY_NAME, SECRET_PASSPHRASE_NAME, ROOT_FLOOR

   The second list is the credential-destination set. Change any of it and the
   key goes somewhere else, which is exactly what the registry exists to
   prevent. ROOT_FLOOR is in that list because a boundary the app can move is
   not a boundary.

   NULL means "leave alone" for every parameter, so the app can send a partial
   update without having to read and echo back the values it is not changing.
-------------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS SPOT_DW.SFTP_ADMIN.SFTP_ENDPOINT_AUDIT (
    AUDIT_ID        NUMBER AUTOINCREMENT START 1 INCREMENT 1,
    ENDPOINT_NAME   VARCHAR(64)   NOT NULL,
    FIELD           VARCHAR(64)   NOT NULL,
    OLD_VALUE       VARCHAR(1000),
    NEW_VALUE       VARCHAR(1000),
    CHANGED_AT      TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    /* SNOWFLAKE_USER is the session user, and inside EXECUTE AS OWNER that is
       the service account rather than the person — hence ACTOR_ASSERTED beside
       it, which is whatever the app said. It is named "asserted" on purpose:
       Snowflake cannot corroborate it, and an audit column that looks
       authenticated but is not is worse than one that admits what it is. */
    SNOWFLAKE_USER  VARCHAR(255)  DEFAULT CURRENT_USER()
                    COMMENT 'Session user. Under EXECUTE AS OWNER this is the service account.',
    ACTOR_ASSERTED  VARCHAR(255)
                    COMMENT 'Actor claimed by the app. Not verified by Snowflake.'
);

CREATE OR REPLACE PROCEDURE SPOT_DW.SFTP_ADMIN.SP_SFTP_ENDPOINT_UPDATE(
    ENDPOINT        STRING,
    ACTOR           STRING,
    NEW_LABEL       STRING,
    NEW_ALLOWED_ROOT STRING,
    NEW_MAX_ENTRIES NUMBER,
    NEW_MAX_LINES   NUMBER,
    NEW_MAX_BYTES   NUMBER,
    NEW_ENABLED     BOOLEAN,
    NEW_NOTES       STRING
)
RETURNS VARIANT
LANGUAGE PYTHON
RUNTIME_VERSION = '3.11'
PACKAGES = ('snowflake-snowpark-python',)
HANDLER = 'run'
EXECUTE AS OWNER
AS
$BODY$
import posixpath
import re
import traceback

REGISTRY = 'SPOT_DW.SFTP_ADMIN.SFTP_ENDPOINTS'
AUDIT = 'SPOT_DW.SFTP_ADMIN.SFTP_ENDPOINT_AUDIT'

# Bounds on the caps themselves. A cap the app can set to a billion is not a
# cap; these are the limits on the limits.
CAP_BOUNDS = {
    'MAX_ENTRIES':    (1, 5000),
    'MAX_PEEK_LINES': (1, 500),
    'MAX_PEEK_BYTES': (1024, 64 * 1024 * 1024),
}


def _norm_path(p):
    q = re.sub(r'/{2,}', '/', (p or '').strip())
    if not q:
        return ''
    if not q.startswith('/'):
        q = '/' + q
    return re.sub(r'/{2,}', '/', posixpath.normpath(q))


def _within(child, parent):
    """Is child at or below parent? Trailing-slash prefix test, so
    /spot_money_other does not pass a parent of /spot_money."""
    return child == parent or child.startswith(parent.rstrip('/') + '/')


def run(session, endpoint, actor, new_label, new_allowed_root,
        new_max_entries, new_max_lines, new_max_bytes, new_enabled, new_notes):

    result = {'status': 'FAILED', 'endpoint': None, 'changed': [], 'error_message': None}
    try:
        n = (endpoint or '').strip().upper()
        if not re.match(r'^[A-Z0-9_]+$', n or ''):
            raise ValueError('Endpoint name {!r} is not a plain identifier.'.format(endpoint))
        result['endpoint'] = n

        who = (actor or '').strip()[:255] or None

        rows = session.sql(
            'SELECT LABEL, ROOT_FLOOR, ALLOWED_ROOT, MAX_ENTRIES, MAX_PEEK_LINES, '
            '       MAX_PEEK_BYTES, ENABLED, NOTES '
            '  FROM ' + REGISTRY + ' WHERE UPPER(ENDPOINT_NAME) = ?',
            params=[n],
        ).collect()
        if not rows:
            raise ValueError('No SFTP endpoint registered as {!r}.'.format(n))
        if len(rows) > 1:
            raise ValueError(
                '{} rows registered for {!r}; the primary key is not enforced by '
                'Snowflake. De-duplicate before editing.'.format(len(rows), n)
            )
        cur = rows[0].as_dict()

        updates = []          # (column, sql_placeholder_value)
        changes = []          # (field, old, new) for the audit

        if new_label is not None and new_label != cur['LABEL']:
            updates.append(('LABEL', new_label))
            changes.append(('LABEL', cur['LABEL'], new_label))

        if new_notes is not None and new_notes != cur['NOTES']:
            updates.append(('NOTES', new_notes))
            changes.append(('NOTES', cur['NOTES'], new_notes))

        if new_enabled is not None and bool(new_enabled) != bool(cur['ENABLED']):
            updates.append(('ENABLED', bool(new_enabled)))
            changes.append(('ENABLED', str(cur['ENABLED']), str(bool(new_enabled))))

        if new_allowed_root is not None:
            floor = _norm_path(cur['ROOT_FLOOR'])
            want = _norm_path(new_allowed_root)
            if not want:
                raise ValueError('ALLOWED_ROOT cannot be blank.')
            if want == '/':
                raise ValueError('ALLOWED_ROOT of / is not a boundary.')
            if not floor or floor == '/':
                raise ValueError(
                    'Endpoint {!r} has no usable ROOT_FLOOR, so no root can be '
                    'validated against it. Fix the row in Snowflake first.'.format(n)
                )
            # NARROWING ONLY. This is the whole point of the floor: the app may
            # move the starting point around inside the subtree it was given, and
            # cannot escape it.
            if not _within(want, floor):
                raise ValueError(
                    'Refusing ALLOWED_ROOT {!r}: it is outside this endpoint\'s '
                    'ROOT_FLOOR {!r}. The floor is set in Snowflake and cannot be '
                    'widened from the app.'.format(want, floor)
                )
            if want != _norm_path(cur['ALLOWED_ROOT']):
                updates.append(('ALLOWED_ROOT', want))
                changes.append(('ALLOWED_ROOT', cur['ALLOWED_ROOT'], want))

        for param, col in ((new_max_entries, 'MAX_ENTRIES'),
                           (new_max_lines, 'MAX_PEEK_LINES'),
                           (new_max_bytes, 'MAX_PEEK_BYTES')):
            if param is None:
                continue
            lo, hi = CAP_BOUNDS[col]
            try:
                v = int(param)
            except (TypeError, ValueError):
                raise ValueError('{} must be a whole number, got {!r}.'.format(col, param))
            if v < lo or v > hi:
                raise ValueError(
                    '{} must be between {} and {}, got {}.'.format(col, lo, hi, v)
                )
            if v != int(cur[col]):
                updates.append((col, v))
                changes.append((col, str(cur[col]), str(v)))

        if not updates:
            result['status'] = 'NO_CHANGE'
            return result

        # Column names come from the tuples above and never from the caller, so
        # interpolating them is safe; every VALUE is bound.
        set_sql = ', '.join('{} = ?'.format(c) for c, _ in updates)
        params = [v for _, v in updates] + [who, n]
        session.sql(
            'UPDATE ' + REGISTRY + ' SET ' + set_sql +
            ', UPDATED_AT = CURRENT_TIMESTAMP(), UPDATED_BY = ? '
            ' WHERE UPPER(ENDPOINT_NAME) = ?',
            params=params,
        ).collect()

        for field, old, new in changes:
            session.sql(
                'INSERT INTO ' + AUDIT +
                ' (ENDPOINT_NAME, FIELD, OLD_VALUE, NEW_VALUE, ACTOR_ASSERTED) '
                ' SELECT ?, ?, ?, ?, ?',
                params=[n, field,
                        None if old is None else str(old)[:1000],
                        None if new is None else str(new)[:1000],
                        who],
            ).collect()

        result['changed'] = [c for c, _ in updates]
        result['status'] = 'SUCCESS'
        return result

    except Exception as exc:
        result['error_message'] = '{}: {}'.format(type(exc).__name__, exc)
        result['traceback'] = traceback.format_exc()
        return result
$BODY$;


/* -----------------------------------------------------------------------------
   SECTION 7 — grants

   CREATE OR REPLACE PROCEDURE drops its grants and has no COPY GRANTS clause,
   so THIS LINE MUST BE RE-RUN every time section 5 is replaced. Forgetting
   produces "Unknown user-defined function", which reads as a missing object
   rather than a missing grant, and costs an afternoon.

   (The secure view in section 3 does carry COPY GRANTS, so replacing that one
   keeps its grant.)
-------------------------------------------------------------------------------- */

GRANT USAGE ON PROCEDURE SPOT_DW.SFTP_ADMIN.SP_SFTP_INSPECT(STRING, STRING, STRING, NUMBER)
  TO ROLE SVC_VERCEL_APP_ROLE;

GRANT USAGE ON PROCEDURE SPOT_DW.SFTP_ADMIN.SP_SFTP_ENDPOINT_UPDATE(
    STRING, STRING, STRING, STRING, NUMBER, NUMBER, NUMBER, BOOLEAN, STRING)
  TO ROLE SVC_VERCEL_APP_ROLE;

/* Still NO privilege on SFTP_ENDPOINTS or SFTP_ENDPOINT_AUDIT. Both procedures
   run as owner; the app can only reach the table through them, which is how the
   editable/not-editable split is enforced given Snowflake has no column-level
   UPDATE grant. */


/* -----------------------------------------------------------------------------
   SECTION 8 — smoke test

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


/* ---- SECTION 6 procedure: settings the app may change -----------------------
   NULL means "leave alone", so a partial update needs no round-trip.
   Every one of these must come back FAILED except the first two. */

-- Narrowing within the floor. Allowed.
CALL SPOT_DW.SFTP_ADMIN.SP_SFTP_ENDPOINT_UPDATE(
  'SPOT', 'you@ignitiongroup.co.za', NULL, '/spot_money/spot_arpu_automation',
  NULL, NULL, NULL, NULL, NULL);

-- Caps and label only, root untouched. Allowed.
CALL SPOT_DW.SFTP_ADMIN.SP_SFTP_ENDPOINT_UPDATE(
  'SPOT', 'you@ignitiongroup.co.za', 'Spot SFTP', NULL, 250, 30, NULL, TRUE, NULL);

-- Re-running the same values returns NO_CHANGE, not SUCCESS, and writes no audit row.
CALL SPOT_DW.SFTP_ADMIN.SP_SFTP_ENDPOINT_UPDATE(
  'SPOT', 'you@ignitiongroup.co.za', 'Spot SFTP', NULL, 250, 30, NULL, TRUE, NULL);

-- Widening past ROOT_FLOOR. MUST be refused — this is the floor doing its job.
CALL SPOT_DW.SFTP_ADMIN.SP_SFTP_ENDPOINT_UPDATE(
  'SPOT', 'you@ignitiongroup.co.za', NULL, '/', NULL, NULL, NULL, NULL, NULL);
CALL SPOT_DW.SFTP_ADMIN.SP_SFTP_ENDPOINT_UPDATE(
  'SPOT', 'you@ignitiongroup.co.za', NULL, '/etc', NULL, NULL, NULL, NULL, NULL);
CALL SPOT_DW.SFTP_ADMIN.SP_SFTP_ENDPOINT_UPDATE(
  'SPOT', 'you@ignitiongroup.co.za', NULL, '/spot_money/../../etc', NULL, NULL, NULL, NULL, NULL);
-- The prefix trap: /spot_money_other is NOT inside /spot_money.
CALL SPOT_DW.SFTP_ADMIN.SP_SFTP_ENDPOINT_UPDATE(
  'SPOT', 'you@ignitiongroup.co.za', NULL, '/spot_money_other', NULL, NULL, NULL, NULL, NULL);

-- A cap outside its bounds. Refused: a cap the app can set to anything is not a cap.
CALL SPOT_DW.SFTP_ADMIN.SP_SFTP_ENDPOINT_UPDATE(
  'SPOT', 'you@ignitiongroup.co.za', NULL, NULL, 999999, NULL, NULL, NULL, NULL);

-- Disable, then re-enable. Both allowed: HOST and HOST_KEY_B64 are immutable
-- from here, so toggling ENABLED cannot redirect the key anywhere.
CALL SPOT_DW.SFTP_ADMIN.SP_SFTP_ENDPOINT_UPDATE(
  'SPOT', 'you@ignitiongroup.co.za', NULL, NULL, NULL, NULL, NULL, FALSE, NULL);
CALL SPOT_DW.SFTP_ADMIN.SP_SFTP_ENDPOINT_UPDATE(
  'SPOT', 'you@ignitiongroup.co.za', NULL, NULL, NULL, NULL, NULL, TRUE, NULL);

-- What the app cannot reach at all. There is no parameter for HOST,
-- SFTP_USER, HOST_KEY_B64, the secret bindings or ROOT_FLOOR — by construction,
-- not by validation. Confirm the row still holds its original values:
SELECT ENDPOINT_NAME, HOST, SFTP_USER, LEFT(HOST_KEY_B64, 24) AS PIN_PREFIX,
       ROOT_FLOOR, ALLOWED_ROOT, MAX_ENTRIES, ENABLED, UPDATED_AT, UPDATED_BY
  FROM SPOT_DW.SFTP_ADMIN.SFTP_ENDPOINTS WHERE ENDPOINT_NAME = 'SPOT';

-- The audit trail. SNOWFLAKE_USER is the service account (EXECUTE AS OWNER);
-- ACTOR_ASSERTED is who the app said it was, and is app-asserted, not proven.
SELECT * FROM SPOT_DW.SFTP_ADMIN.SFTP_ENDPOINT_AUDIT ORDER BY CHANGED_AT DESC LIMIT 20;

-- The app must NOT be able to read the registry directly. Run as the app role:
--   SELECT * FROM SPOT_DW.SFTP_ADMIN.SFTP_ENDPOINTS;         -- expect: refused
--   SELECT * FROM SPOT_DW.SFTP_ADMIN.SFTP_ENDPOINT_AUDIT;    -- expect: refused
--   SELECT * FROM SPOT_DW.SFTP_ADMIN.VW_SFTP_ENDPOINTS_APP;  -- expect: settings only,
--                                                            -- no HOST/SFTP_USER/HOST_KEY_B64
--
-- Then confirm the app can see the procedure, which a worksheet cannot tell you:
--   /api/distribution/snowflake-identity?object=SPOT_DW.SFTP_ADMIN.SP_SFTP_INSPECT
