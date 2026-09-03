/* =============================================================================
   TASK AUTOMATION — the two procedures the app calls to DESIGN a sync
   -----------------------------------------------------------------------------
   Run 00-grants.sql first, then this, as ACCOUNTADMIN.

   These are the only Snowflake objects the app invokes directly. Both are
   read-only: they list and read, they never write and never load. Everything
   that actually moves data is generated per-sync by the app.

   WHY THESE EXIST AT ALL. The app cannot connect to the SFTP itself — the
   private key lives in a Snowflake secret and must stay there. So "browse the
   folders and pick a file" has to happen through Snowflake. SP_SFTP_BROWSE is
   the directory listing; SP_SFTP_PEEK reads the first few lines so the column
   mapper has a header row to work with.

   Both are lifted from the working SP_SPOT_SFTP_INGEST — same connection code,
   same host-key pinning, same key loading. Nothing about authentication is new
   here.

   BEFORE YOU RUN THIS: paste the real host key into HOST_KEY_B64 below. It was
   redacted from the file you sent me, and I have deliberately NOT invented a
   placeholder that looks plausible — an empty value fails loudly at connect
   time, which is the correct behaviour. Get it from the working procedure:

     SELECT GET_DDL('PROCEDURE', 'SP_SPOT_SFTP_INGEST(STRING, STRING, STRING, STRING, BOOLEAN)');
============================================================================= */


/* -----------------------------------------------------------------------------
   SECTION 1 — shared connection code

   Snowflake has no include mechanism for procedure bodies, so this block is
   duplicated in both procedures below. If you change the host, the user or the
   host key, change it in BOTH. That duplication is the price of not having the
   app hold credentials, and it is the right trade.
-------------------------------------------------------------------------------- */


CREATE OR REPLACE PROCEDURE SPOT_DW.SPOT_SFTP.SP_SFTP_BROWSE(REMOTE_DIR STRING)
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

HOST = 'securetransfer.spotplatformapi.com'
PORT = 22
USER = 'ignition_snowflake_sync'

# Host key captured from the endpoint via ssh-keyscan on 2026-08-11.
# PASTE THE REAL VALUE HERE — see the header. Left empty on purpose so a
# forgotten paste fails at connect time rather than silently disabling
# verification.
HOST_KEY_TYPE = 'ssh-rsa'
HOST_KEY_B64 = ''

# A listing is for a human clicking through folders, so it is capped. A folder
# with 40,000 daily files would otherwise return a payload nothing can render.
MAX_ENTRIES = 500

# The subtree the app may reach. '/' means "anywhere this SFTP account can
# already see", which is the SFTP server's own boundary. Tighten it to
# '/spot_money' to confine browsing to the Spot tree — the code below enforces
# whatever is set here.
ALLOWED_ROOT = '/'


def _load_private_key():
    key_material = _snowflake.get_generic_secret_string('pkey')
    try:
        passphrase = _snowflake.get_generic_secret_string('passphrase') or None
    except Exception:
        passphrase = None

    last_error = None
    for key_class in (paramiko.Ed25519Key, paramiko.RSAKey, paramiko.ECDSAKey):
        try:
            return key_class.from_private_key(io.StringIO(key_material), password=passphrase)
        except paramiko.SSHException as exc:
            last_error = exc

    raise RuntimeError(
        'Could not load the private key from the secret. Check the full key '
        'including BEGIN/END lines was pasted and the passphrase matches. '
        'Last error: {}'.format(last_error)
    )


def _connect():
    if not HOST_KEY_B64:
        raise RuntimeError(
            'HOST_KEY_B64 is empty. Paste the pinned host key into this '
            'procedure before using it. Refusing to connect without host key '
            'verification.'
        )

    client = paramiko.SSHClient()
    expected = paramiko.RSAKey(data=base64.b64decode(HOST_KEY_B64))
    client.get_host_keys().add(HOST, HOST_KEY_TYPE, expected)
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    client.connect(
        hostname=HOST, port=PORT, username=USER, pkey=_load_private_key(),
        allow_agent=False, look_for_keys=False,
        timeout=60, banner_timeout=60, auth_timeout=60,
    )
    return client


def _safe_path(raw, default_root=True):
    """Normalise a path and refuse anything outside ALLOWED_ROOT.

    THE ROOT CHECK IS THE CONTROL, not a check for '..'. posixpath.normpath
    CLAMPS at root, so '/spot_money/../../etc' normalises to '/etc' with no '..'
    left in it — a '..' test applied after normalising is dead code and passes
    that path. Duplicate slashes are collapsed first because normpath preserves
    a leading '//' (a POSIX quirk), which would then fail a prefix comparison.

    The trailing-slash form of the prefix test matters too: without it,
    '/spot_money_other' would pass a root of '/spot_money'.
    """
    p = (raw or '').strip()
    if not p:
        if not default_root:
            raise ValueError('No path given.')
        p = ALLOWED_ROOT
    if not p.startswith('/'):
        p = '/' + p
    p = re.sub(r'/{2,}', '/', p)
    p = posixpath.normpath(p)
    root = re.sub(r'/{2,}', '/', posixpath.normpath(ALLOWED_ROOT))
    if p != root and not p.startswith(root.rstrip('/') + '/'):
        raise ValueError(
            'Refusing {!r}: resolves to {!r}, outside the permitted root {!r}.'
            .format(raw, p, root)
        )
    return p


def run(session, remote_dir):
    result = {
        'status': 'FAILED',
        'remote_dir': None,
        'entries': [],
        'entry_count': 0,
        'truncated': False,
        'error_message': None,
    }
    client = None
    try:
        d = _safe_path(remote_dir)
        result['remote_dir'] = d

        client = _connect()
        sftp = client.open_sftp()
        try:
            entries = sftp.listdir_attr(d)
        finally:
            sftp.close()

        # Directories first, then files, each alphabetically — a browser, not a
        # data feed, so a stable readable order beats server order.
        rows = []
        for e in entries:
            is_dir = e.st_mode is not None and statmod.S_ISDIR(e.st_mode)
            rows.append({
                'name': e.filename,
                'is_dir': is_dir,
                'size': None if is_dir else e.st_size,
                'mtime_epoch': e.st_mtime,
                'path': posixpath.join(d, e.filename),
            })
        rows.sort(key=lambda r: (not r['is_dir'], r['name'].lower()))

        result['entry_count'] = len(rows)
        if len(rows) > MAX_ENTRIES:
            result['truncated'] = True
            rows = rows[:MAX_ENTRIES]
        result['entries'] = rows
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
   SECTION 2 — read the head of one file, so the mapper has a header row

   Returns raw lines rather than parsed fields. Delimiter sniffing belongs in
   the app, where the user can see it and correct it — a procedure guessing
   silently is how you end up with a one-column table.
-------------------------------------------------------------------------------- */

CREATE OR REPLACE PROCEDURE SPOT_DW.SPOT_SFTP.SP_SFTP_PEEK(
    REMOTE_PATH STRING,
    MAX_LINES   NUMBER
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
import traceback

import paramiko
import _snowflake

HOST = 'securetransfer.spotplatformapi.com'
PORT = 22
USER = 'ignition_snowflake_sync'

# See the note in SP_SFTP_BROWSE. Keep both in step.
HOST_KEY_TYPE = 'ssh-rsa'
HOST_KEY_B64 = ''

# Two independent caps. MAX_LINES bounds what comes back; MAX_BYTES bounds what
# is read off the wire, because a "CSV" that turns out to be one 4 GB line
# would otherwise be pulled in full before the line cap could apply.
LINE_LIMIT = 50
MAX_BYTES = 1024 * 1024

# The subtree the app may reach. '/' means "anywhere this SFTP account can
# already see", which is the SFTP server's own boundary. Tighten it to
# '/spot_money' to confine browsing to the Spot tree — the code below enforces
# whatever is set here.
ALLOWED_ROOT = '/'


def _load_private_key():
    key_material = _snowflake.get_generic_secret_string('pkey')
    try:
        passphrase = _snowflake.get_generic_secret_string('passphrase') or None
    except Exception:
        passphrase = None

    last_error = None
    for key_class in (paramiko.Ed25519Key, paramiko.RSAKey, paramiko.ECDSAKey):
        try:
            return key_class.from_private_key(io.StringIO(key_material), password=passphrase)
        except paramiko.SSHException as exc:
            last_error = exc

    raise RuntimeError(
        'Could not load the private key from the secret. Last error: {}'.format(last_error)
    )


def _connect():
    if not HOST_KEY_B64:
        raise RuntimeError(
            'HOST_KEY_B64 is empty. Paste the pinned host key into this '
            'procedure before using it. Refusing to connect without host key '
            'verification.'
        )

    client = paramiko.SSHClient()
    expected = paramiko.RSAKey(data=base64.b64decode(HOST_KEY_B64))
    client.get_host_keys().add(HOST, HOST_KEY_TYPE, expected)
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    client.connect(
        hostname=HOST, port=PORT, username=USER, pkey=_load_private_key(),
        allow_agent=False, look_for_keys=False,
        timeout=60, banner_timeout=60, auth_timeout=60,
    )
    return client


def _safe_path(raw, default_root=False):
    """Normalise a path and refuse anything outside ALLOWED_ROOT.

    THE ROOT CHECK IS THE CONTROL, not a check for '..'. posixpath.normpath
    CLAMPS at root, so '/spot_money/../../etc' normalises to '/etc' with no '..'
    left in it — a '..' test applied after normalising is dead code and passes
    that path. Duplicate slashes are collapsed first because normpath preserves
    a leading '//' (a POSIX quirk), which would then fail a prefix comparison.

    The trailing-slash form of the prefix test matters too: without it,
    '/spot_money_other' would pass a root of '/spot_money'.
    """
    p = (raw or '').strip()
    if not p:
        if not default_root:
            raise ValueError('No path given.')
        p = ALLOWED_ROOT
    if not p.startswith('/'):
        p = '/' + p
    p = re.sub(r'/{2,}', '/', p)
    p = posixpath.normpath(p)
    root = re.sub(r'/{2,}', '/', posixpath.normpath(ALLOWED_ROOT))
    if p != root and not p.startswith(root.rstrip('/') + '/'):
        raise ValueError(
            'Refusing {!r}: resolves to {!r}, outside the permitted root {!r}.'
            .format(raw, p, root)
        )
    return p


def run(session, remote_path, max_lines):
    try:
        want = int(max_lines) if max_lines else 20
    except (TypeError, ValueError):
        want = 20
    want = max(1, min(want, LINE_LIMIT))

    result = {
        'status': 'FAILED',
        'remote_path': None,
        'lines': [],
        'line_count': 0,
        'size': None,
        'mtime_epoch': None,
        'bytes_read': 0,
        'byte_capped': False,
        'error_message': None,
    }
    client = None
    try:
        p = _safe_path(remote_path)
        result['remote_path'] = p

        client = _connect()
        sftp = client.open_sftp()
        try:
            st = sftp.stat(p)
            result['size'] = st.st_size
            result['mtime_epoch'] = st.st_mtime

            chunks = []
            read = 0
            with sftp.open(p, 'r') as fh:
                fh.prefetch(min(st.st_size or MAX_BYTES, MAX_BYTES))
                while read < MAX_BYTES:
                    block = fh.read(min(65536, MAX_BYTES - read))
                    if not block:
                        break
                    chunks.append(block)
                    read += len(block)
                    # Stop as soon as enough newlines have been seen; no point
                    # reading a 200 MB file to show 20 lines.
                    if b''.join(chunks).count(b'\n') > want:
                        break
            result['bytes_read'] = read
            result['byte_capped'] = read >= MAX_BYTES
        finally:
            sftp.close()

        raw = b''.join(chunks)
        # errors='replace' rather than 'strict': the point is to show the
        # operator what is in the file, and a mis-encoded byte should surface as
        # a visible replacement character, not an exception that hides the
        # header.
        text = raw.decode('utf-8-sig', errors='replace')
        lines = text.splitlines()[:want]
        result['lines'] = lines
        result['line_count'] = len(lines)
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
   SECTION 3 — grants

   CREATE OR REPLACE PROCEDURE drops its grants and has no COPY GRANTS clause,
   so THESE TWO LINES MUST BE RE-RUN every time either procedure above is
   replaced. Forgetting produces "Unknown user-defined function", which reads
   as a missing object rather than a missing grant.
-------------------------------------------------------------------------------- */

GRANT USAGE ON PROCEDURE SPOT_DW.SPOT_SFTP.SP_SFTP_BROWSE(STRING)
  TO ROLE SVC_VERCEL_APP_ROLE;

GRANT USAGE ON PROCEDURE SPOT_DW.SPOT_SFTP.SP_SFTP_PEEK(STRING, NUMBER)
  TO ROLE SVC_VERCEL_APP_ROLE;


/* -----------------------------------------------------------------------------
   SECTION 4 — smoke test

   Neither procedure raises on failure; both return a VARIANT with
   status = 'FAILED' and an error_message. So check the status, do not just
   check that the CALL succeeded.
-------------------------------------------------------------------------------- */

CALL SPOT_DW.SPOT_SFTP.SP_SFTP_BROWSE('/spot_money/spot_arpu_automation/config_files/rates/');

CALL SPOT_DW.SPOT_SFTP.SP_SFTP_PEEK(
  '/spot_money/spot_arpu_automation/config_files/rates/<<A_REAL_FILENAME>>', 5);

/* Path handling. With ALLOWED_ROOT = '/' the first of these RESOLVES to '/etc'
   and succeeds — normpath clamps at root, so '..' cannot escape but it can
   still relocate. That is only acceptable because the SFTP account's own
   permissions are the real boundary. Set ALLOWED_ROOT = '/spot_money' in both
   procedures and it is refused instead. Run both and confirm you get the
   behaviour you expect from whichever root you chose. */
CALL SPOT_DW.SPOT_SFTP.SP_SFTP_BROWSE('/spot_money/../../etc');
CALL SPOT_DW.SPOT_SFTP.SP_SFTP_BROWSE('//spot_money//spot_arpu_automation//');

-- Then confirm the APP can see them, which a worksheet cannot tell you:
--   /api/distribution/snowflake-identity?object=SPOT_DW.SPOT_SFTP.SP_SFTP_BROWSE
