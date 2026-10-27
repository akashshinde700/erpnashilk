"""
ManuFlow ERP (multi-tenant manufacturing SaaS) -- deploy this repo to the
CloudPanel VPS that serves https://www.menu.aetherdevsolutions.online (200.141.9.196).

Production shape:
  - Next.js 16 standalone build, PM2 process `manuflow`, port 3008
  - PM2 runs  <APP>/.next/standalone/server.js  with cwd = .next/standalone
  - MySQL database `manufacture` (CloudPanel), schema via `prisma db push`
  - Env comes from <APP>/.env, which Next loads from .next/standalone/.env
    at runtime. The server's .env is the source of truth; this script never
    uploads or rewrites it.

  The build happens in a separate staging dir so the live app keeps running,
  then the new .next is swapped in. The old .next is kept under
  ~/backups/releases/ for --rollback. The first deploy (no .next yet) starts
  the PM2 process instead of restarting it.

Run:
  python deploy.py              # build in staging, swap, restart, health check
  python deploy.py --check      # read-only status of the live site
  python deploy.py --no-db-push # skip `prisma db push`
  python deploy.py --rollback   # put the previous release back
  python deploy.py --stage      # upload + type check + lint + build in staging only
                                #   (no DB push, live site untouched)

Credentials come from deploy_config.manuflow.json (gitignored) next to this
script, or the file named by DEPLOY_CONFIG. It must exist -- there is no
fallback to deploy_config.json, which belongs to another project. Keys:
  site_password     the `menu` SSH password (required)
  host_key_sha256   the server's SSH host key fingerprint, as
                    `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` prints it
                    (required; checked before the password is sent)

Before touching anything the script checks that the remote site really is
ManuFlow and that <APP>/.env carries every required key. A full deploy dumps
the database to ~/backups/predeploy/ and stops if the dump fails.
"""

import base64
import hashlib
import json
import os
import sys
import time

import paramiko

LOCAL_ROOT = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.environ.get("DEPLOY_CONFIG") or os.path.join(LOCAL_ROOT, "deploy_config.manuflow.json")

ARGS = sys.argv[1:]
CHECK_ONLY = "--check" in ARGS
ROLLBACK = "--rollback" in ARGS
STAGE_ONLY = "--stage" in ARGS
DB_PUSH = "--no-db-push" not in ARGS and not STAGE_ONLY

# -- Config ---------------------------------------------------
CFG = {
    "host": "200.141.9.196",
    "site_user": "menu",
    "site_password": "",  # config file only -- never commit a password
    "site_domain": "www.menu.aetherdevsolutions.online",
    "app_port": 3008,
    "pm2_name": "manuflow",
    "keep_releases": 3,
    "host_key_sha256": "",
}
if not os.path.isfile(CONFIG_PATH):
    print(f"[ERROR] {CONFIG_PATH} not found.", flush=True)
    sys.exit(1)
with open(CONFIG_PATH, "r", encoding="utf-8") as _f:
    CFG.update(json.load(_f))

HOST = CFG["host"]
SITE_USER = CFG["site_user"]
SITE_PASSWORD = CFG["site_password"]
SITE_DOMAIN = CFG["site_domain"]
APP_PORT = int(CFG["app_port"])
PM2_NAME = CFG["pm2_name"]
KEEP_RELEASES = int(CFG["keep_releases"])
HOST_KEY_SHA256 = CFG["host_key_sha256"].strip().removeprefix("SHA256:").rstrip("=")

SITE_HOME = f"/home/{SITE_USER}"
APP = f"{SITE_HOME}/htdocs/{SITE_DOMAIN}"
STANDALONE = f"{APP}/.next/standalone"
STAGING = f"{SITE_HOME}/tmp/deploy-staging"
RELEASES = f"{SITE_HOME}/backups/releases"
DB_BACKUPS = f"{SITE_HOME}/backups/predeploy"

NVM_INIT = f'export NVM_DIR="{SITE_HOME}/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"'

# Written by the app at runtime, relative to .next/standalone.
RUNTIME_DIRS = []  # ManuFlow keeps all state in MySQL

# Copied into the standalone dir on every deploy, so a key missing here is a key
# missing in production. Checked by name only; values are never read back.
REQUIRED_ENV = ["DATABASE_URL", "SESSION_SECRET"]
# Banner line of prisma/schema.prisma -- proves the remote dir is this app.
APP_MARKER = "ManuFlow ERP"

# Source that gets uploaded. Everything else (node_modules, .next, .env,
# deploy files, docs) stays local.
UPLOAD_DIRS = ["src", "prisma", "scripts", "public"]
UPLOAD_FILES = [
    "package.json", "package-lock.json", "next.config.ts", "tsconfig.json",
    "tailwind.config.ts", "postcss.config.mjs", "eslint.config.mjs",
    "components.json", "next-env.d.ts",
]
SKIP_DIRS = {"node_modules", ".next", "__pycache__", "uploads"}
SKIP_EXTS = {".log", ".pid", ".tsbuildinfo"}


# -- helpers --------------------------------------------------
def p(text=""):
    try:
        print(text, flush=True)
    except UnicodeEncodeError:
        enc = sys.stdout.encoding or "ascii"
        print(str(text).encode(enc, "replace").decode(enc), flush=True)


def banner(title):
    p("\n" + "=" * 64 + f"\n{title}\n" + "=" * 64)


def run(ssh, command, timeout=600, check=False, quiet=False):
    if not quiet:
        p(f"\n[CMD] {command}")
    # pipefail: `cmd | tail` must fail when cmd fails, or a broken db push/build slips through.
    _, stdout, stderr = ssh.exec_command(f"{NVM_INIT}; set -o pipefail; {command}", timeout=timeout)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    code = stdout.channel.recv_exit_status()
    if not quiet:
        p(out.rstrip())
        if err.strip():
            p(err.rstrip())
        p(f"[exit {code}]")
    if check and code != 0:
        raise RuntimeError(f"remote command failed ({code}): {command}")
    return out, err, code


def fingerprint(key):
    return base64.b64encode(hashlib.sha256(key.asbytes()).digest()).decode().rstrip("=")


class PinnedHostKey(paramiko.MissingHostKeyPolicy):
    # paramiko consults this before authenticating, so a server with the wrong
    # key never receives the password.
    def missing_host_key(self, client, hostname, key):
        fp = fingerprint(key)
        if fp != HOST_KEY_SHA256:
            raise paramiko.SSHException(f"host key mismatch for {hostname}: server presented SHA256:{fp}")


def connect():
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(PinnedHostKey())
    c.connect(HOST, username=SITE_USER, password=SITE_PASSWORD, timeout=30,
              look_for_keys=False, allow_agent=False)
    return c


def verify_target(ssh):
    """Refuse to touch a site that isn't ManuFlow, or whose .env would break login."""
    out, _, code = run(ssh, f"head -5 {APP}/prisma/schema.prisma 2>/dev/null", quiet=True)
    if code != 0:
        # No schema: only acceptable for a fresh CloudPanel site (first deploy).
        out, _, _ = run(ssh, f"ls -A {APP} 2>/dev/null | grep -vxE '\\.well-known|\\.env|\\.gitignore' || true",
                        quiet=True)
        code = 0 if out.strip() else 1
    if code == 0 and APP_MARKER not in out:
        raise RuntimeError(f"{APP} is not a {APP_MARKER} site -- check site_user/site_domain in {CONFIG_PATH}")
    out, _, _ = run(ssh, "pm2 jlist 2>/dev/null", quiet=True)
    try:
        procs = {x["name"]: x["pm2_env"].get("pm_cwd") for x in json.loads(out or "[]")}
    except (ValueError, KeyError, TypeError):
        procs = {}
    if PM2_NAME in procs and procs[PM2_NAME] != STANDALONE:
        raise RuntimeError(f"PM2 process {PM2_NAME} runs from {procs[PM2_NAME]}, not {STANDALONE}")
    missing = [k for k in REQUIRED_ENV
               if run(ssh, f"grep -qE '^{k}=.+' {APP}/.env", quiet=True)[2] != 0]
    if missing:
        raise RuntimeError(f"{APP}/.env is missing {', '.join(missing)} -- add it on the server first")
    p(f"  target verified: {SITE_USER}@{HOST} {APP} (pm2 {PM2_NAME})")


# Runs on the server as the site user: reads DATABASE_URL from the given .env,
# writes the credentials to a 0600 defaults-file (never argv, never stdout) and
# dumps to <dest>.tmp, renaming only after mysqldump and gzip both succeed.
DUMP_PY = r'''
import os, subprocess, sys, tempfile, urllib.parse as u
env, dest = sys.argv[1], sys.argv[2]
url = next(l.split("=", 1)[1].strip().strip('"').strip("'") for l in open(env) if l.startswith("DATABASE_URL="))
p = u.urlparse(url)
fd, cnf = tempfile.mkstemp(); os.chmod(cnf, 0o600)
os.write(fd, ("[client]\nuser=%s\npassword=%s\nhost=%s\nport=%s\n" % (
    u.unquote(p.username or ""), u.unquote(p.password or ""), p.hostname, p.port or 3306)).encode()); os.close(fd)
try:
    with open(dest + ".tmp", "wb") as out:
        os.chmod(dest + ".tmp", 0o600)
        d = subprocess.Popen(["mysqldump", "--defaults-extra-file=" + cnf, "--single-transaction", "--quick",
                              "--routines", "--triggers", "--no-tablespaces", p.path.lstrip("/")],
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        g = subprocess.run(["gzip", "-c"], stdin=d.stdout, stdout=out)
        d.stdout.close(); err = d.stderr.read().decode(errors="replace"); d.wait()
    if d.returncode or g.returncode:
        os.remove(dest + ".tmp"); sys.exit("mysqldump failed: " + err[-400:])
    os.rename(dest + ".tmp", dest)
finally:
    os.remove(cnf)
'''


def backup_db(ssh, env_file, stamp):
    dest = f"{DB_BACKUPS}/{stamp}.sql.gz"
    run(ssh, f"mkdir -p {DB_BACKUPS} && chmod 700 {DB_BACKUPS}", check=True)
    _, stdout, stderr = ssh.exec_command(f"python3 - {env_file} {dest}", timeout=900)
    stdout.channel.sendall(DUMP_PY.encode()); stdout.channel.shutdown_write()
    out, err = stdout.read().decode("utf-8", "replace"), stderr.read().decode("utf-8", "replace")
    if stdout.channel.recv_exit_status() != 0:
        raise RuntimeError(f"database backup failed -- deploy stopped: {(out + err).strip()[-400:]}")
    # A real dump ends with mysqldump's completion line; a truncated one doesn't.
    out, _, code = run(ssh, f"stat -c %s {dest} && zcat {dest} | tail -1 | grep -q 'Dump completed'", quiet=True)
    if code != 0:
        raise RuntimeError(f"database backup {dest} is incomplete -- deploy stopped")
    p(f"  database backup: {dest} ({int(out.split()[0]) / 1024:.0f} KB gz, verified complete)")
    return dest


def sftp_mkdirs(sftp, remote_dir):
    cur = ""
    for part in remote_dir.strip("/").split("/"):
        cur += "/" + part
        try:
            sftp.stat(cur)
        except FileNotFoundError:
            sftp.mkdir(cur)


def sftp_put(sftp, local, remote):
    # Windows runs out of socket buffer space (WinError 10055) partway through
    # a few hundred rapid puts; backing off and retrying clears it.
    for attempt in range(4):
        try:
            sftp.put(local, remote)
            return
        except OSError as ex:
            if attempt == 3:
                raise
            p(f"  [retry {attempt + 1}] {os.path.basename(local)}: {ex}")
            time.sleep(1.5 * (attempt + 1))


def upload_source(sftp, remote_root):
    count = 0
    for name in UPLOAD_FILES:
        local = os.path.join(LOCAL_ROOT, name)
        if os.path.isfile(local):
            sftp_put(sftp, local, f"{remote_root}/{name}")
            count += 1
    for top in UPLOAD_DIRS:
        base = os.path.join(LOCAL_ROOT, top)
        if not os.path.isdir(base):
            continue
        for root, dirs, files in os.walk(base):
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
            rel = os.path.relpath(root, LOCAL_ROOT).replace(os.sep, "/")
            rdir = f"{remote_root}/{rel}"
            sftp_mkdirs(sftp, rdir)
            for fn in files:
                if os.path.splitext(fn)[1] in SKIP_EXTS:
                    continue
                sftp_put(sftp, os.path.join(root, fn), f"{rdir}/{fn}")
                count += 1
                if count % 100 == 0:
                    p(f"  ... {count} files")
    p(f"  {count} files -> {remote_root}")
    return count


def http_status(ssh, url, insecure=False):
    out, _, _ = run(ssh, f"curl -s{'k' if insecure else ''} -o /dev/null -w '%{{http_code}}' "
                         f"--max-time 25 {url} || true", quiet=True)
    return out.strip() or "no response"


def copy_runtime(ssh, src_standalone, dst_standalone):
    for d in RUNTIME_DIRS:
        run(ssh, f"if [ -d {src_standalone}/{d} ]; then mkdir -p {dst_standalone}/{d} && "
                 f"cp -a {src_standalone}/{d}/. {dst_standalone}/{d}/; fi", check=True)


def health(ssh):
    time.sleep(8)
    local = http_status(ssh, f"http://127.0.0.1:{APP_PORT}/")
    public = http_status(ssh, f"https://{SITE_DOMAIN}/", insecure=True)
    # A dummy session cookie makes the middleware HMAC it: 401 means SESSION_SECRET
    # is loaded, 500 means login is broken even though / still renders.
    out, _, _ = run(ssh, f"curl -s -o /dev/null -w '%{{http_code}}' --max-time 25 "
                         f"-H 'Cookie: erp_session=health.check' http://127.0.0.1:{APP_PORT}/api/auth/me || true",
                    quiet=True)
    session = out.strip() or "no response"
    p(f"[local]  GET 127.0.0.1:{APP_PORT}/ -> {local}")
    p(f"[local]  GET /api/auth/me (dummy session) -> {session}  (expect 401)")
    p(f"[public] GET https://{SITE_DOMAIN}/ -> {public}")
    return local in ("200", "307", "308") and session == "401"


# -- modes ----------------------------------------------------
def check(ssh):
    banner(f"Live status: {SITE_DOMAIN}")
    verify_target(ssh)
    run(ssh, f"uptime; df -h {SITE_HOME} | tail -1; node -v")
    run(ssh, "pm2 list 2>&1 | cat")
    run(ssh, f"cat {STANDALONE}/.next/BUILD_ID 2>/dev/null; echo; ls -la --time-style=long-iso {STANDALONE}/server.js")
    run(ssh, f"cd {STANDALONE} && du -sh {' '.join(RUNTIME_DIRS)} 2>/dev/null")
    run(ssh, f"ls -1t {RELEASES} 2>/dev/null | head")
    run(ssh, f"pm2 logs {PM2_NAME} --err --lines 15 --nostream 2>&1 | cat")
    health(ssh)


def rollback(ssh):
    banner("Rollback to previous release")
    verify_target(ssh)
    out, _, _ = run(ssh, f"ls -1t {RELEASES} 2>/dev/null | grep -v rolledback | head -1", quiet=True)
    prev = out.strip()
    if not prev:
        raise RuntimeError(f"no release in {RELEASES}")
    prev_dir = f"{RELEASES}/{prev}"
    p(f"  restoring {prev_dir}")
    stamp = time.strftime("%Y%m%d-%H%M%S")
    run(ssh, f"pm2 stop {PM2_NAME} 2>&1 | cat")
    copy_runtime(ssh, STANDALONE, f"{prev_dir}/standalone")
    run(ssh, f"mv {APP}/.next {RELEASES}/next-{stamp}-rolledback && mv {prev_dir} {APP}/.next", check=True)
    run(ssh, f"pm2 restart {PM2_NAME} 2>&1 | cat", check=True)
    if not health(ssh):
        raise RuntimeError(f"rolled-back release {prev} is not healthy either -- check pm2 logs {PM2_NAME}")


def deploy(ssh):
    stamp = time.strftime("%Y%m%d-%H%M%S")

    banner("[1] Preflight")
    run(ssh, "node -v; npm -v; command -v pm2 >/dev/null || npm install -g pm2 2>&1 | tail -3", check=True)
    run(ssh, f"test -f {APP}/.env", check=True)
    verify_target(ssh)
    run(ssh, f"df -h {SITE_HOME} | tail -1")
    _, _, code = run(ssh, f"test -f {STANDALONE}/server.js && pm2 describe {PM2_NAME} >/dev/null")
    first = code != 0
    if first:
        p("  first deploy -- PM2 process will be created")

    banner("[2] Upload source to staging")
    # node_modules is kept between deploys so npm install is incremental.
    run(ssh, f"mkdir -p {STAGING} && cd {STAGING} && "
             f"find . -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {{}} +", check=True)
    sftp = ssh.open_sftp()
    try:
        n = upload_source(sftp, STAGING)
    finally:
        sftp.close()
    if n < 50:
        raise RuntimeError(f"only {n} files uploaded -- aborting")
    run(ssh, f"cp {APP}/.env {STAGING}/.env && chmod 600 {STAGING}/.env", check=True)
    # The repo is locked with bun, so there's no local package-lock.json; reuse the
    # live one so npm installs the versions already running instead of re-resolving ^ranges.
    run(ssh, f"[ -f {STAGING}/package-lock.json ] || [ ! -f {APP}/package-lock.json ] || "
             f"cp {APP}/package-lock.json {STAGING}/package-lock.json", check=True)

    if not STAGE_ONLY:
        banner("[2b] Database backup")
        # Before db push and the swap: a release rollback restores code only, so
        # this dump is what puts data back if a schema change goes wrong.
        backup_db(ssh, f"{APP}/.env", stamp)

    banner("[3] npm install + prisma")
    run(ssh, f"cd {STAGING} && npm install --no-audit --no-fund 2>&1 | tail -15", timeout=1800, check=True)
    run(ssh, f"cd {STAGING} && npx prisma generate 2>&1 | tail -5", check=True)
    if DB_PUSH:
        # No --accept-data-loss: a schema change that would drop data makes
        # this fail and the deploy stops before touching the running app.
        run(ssh, f"cd {STAGING} && npx prisma db push --skip-generate 2>&1 | tail -15",
            timeout=600, check=True)

    if STAGE_ONLY:
        banner("[3b] Type check + lint")
        run(ssh, f"cd {STAGING} && npx tsc --noEmit -p . 2>&1 | tail -40", timeout=1200, check=True)
        run(ssh, f"cd {STAGING} && npx eslint src 2>&1 | tail -40", timeout=1200)

    banner("[4] next build (staging -- live app keeps running)")
    run(ssh, f"cd {STAGING} && npm run build 2>&1 | tail -40", timeout=2400, check=True)
    run(ssh, f"test -f {STAGING}/.next/standalone/server.js", check=True)
    # Next loads .env from the standalone dir at runtime; don't rely on file
    # tracing to have copied it.
    run(ssh, f"cp {STAGING}/.env {STAGING}/.next/standalone/.env && "
             f"chmod 600 {STAGING}/.next/standalone/.env", check=True)

    if STAGE_ONLY:
        banner("[STAGED] build OK -- live site not changed")
        return

    banner("[5] Swap release")
    run(ssh, f"mkdir -p {RELEASES}", check=True)
    if first:
        run(ssh, f"rm -rf {APP}/.next && mv {STAGING}/.next {APP}/.next", check=True)
    else:
        run(ssh, f"pm2 stop {PM2_NAME} 2>&1 | cat", check=True)
        # Copied after the stop so nothing written mid-deploy is lost.
        copy_runtime(ssh, STANDALONE, f"{STAGING}/.next/standalone")
        run(ssh, f"mv {APP}/.next {RELEASES}/next-{stamp} && mv {STAGING}/.next {APP}/.next", check=True)
    # Keep the htdocs source in step with what is running.
    run(ssh, f"cd {APP} && rm -rf {' '.join(UPLOAD_DIRS)} && cd {STAGING} && "
             f"for f in {' '.join(UPLOAD_DIRS + UPLOAD_FILES)}; do [ -e $f ] && cp -a $f {APP}/; done; true",
        check=True)
    if first:
        run(ssh, f"cd {STANDALONE} && PORT={APP_PORT} HOSTNAME=127.0.0.1 NODE_ENV=production TZ=Asia/Kolkata "
                 f"pm2 start server.js --name {PM2_NAME} 2>&1 | cat", check=True)
    else:
        # TZ: financial-year and document dates follow Indian time, not the server's UTC.
        run(ssh, f"PORT={APP_PORT} HOSTNAME=127.0.0.1 TZ=Asia/Kolkata NODE_ENV=production "
                 f"pm2 restart {PM2_NAME} --update-env 2>&1 | cat", check=True)
    run(ssh, "pm2 save 2>&1 | cat")

    banner("[6] Health check")
    if not health(ssh):
        if first:
            run(ssh, f"pm2 logs {PM2_NAME} --lines 40 --nostream 2>&1 | cat")
            raise RuntimeError("first release failed health check (nothing to roll back to)")
        p("[WARN] new release not answering -- rolling back")
        run(ssh, f"pm2 logs {PM2_NAME} --lines 30 --nostream 2>&1 | cat")
        rollback(ssh)
        raise RuntimeError("deploy rolled back: new release failed health check")

    run(ssh, f"cd {RELEASES} && ls -1t | tail -n +{KEEP_RELEASES + 1} | xargs -r rm -rf")
    banner("[SUCCESS]")
    p(f"  URL      : https://{SITE_DOMAIN}")
    p(f"  Previous : {RELEASES}/next-{stamp}  (python deploy.py --rollback)")
    p(f"  DB dump  : {DB_BACKUPS}/{stamp}.sql.gz")


def main():
    if not SITE_PASSWORD:
        p(f"[ERROR] site_password is empty in {CONFIG_PATH}.")
        sys.exit(1)
    if not HOST_KEY_SHA256:
        p(f"[ERROR] host_key_sha256 is not set in {CONFIG_PATH}. Confirm it from the Hostinger browser\n"
          f"        terminal: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub")
        sys.exit(1)
    p(f"[CONFIG] {CONFIG_PATH}")
    if not CHECK_ONLY and not os.path.isfile(os.path.join(LOCAL_ROOT, "public", "logo.svg")):
        p("[ERROR] public/ is missing locally -- deploying would ship a site with no logo.")
        sys.exit(1)

    p(f"[CONNECT] {SITE_USER}@{HOST}")
    ssh = connect()
    try:
        if CHECK_ONLY:
            check(ssh)
        elif ROLLBACK:
            rollback(ssh)
        else:
            deploy(ssh)
    except Exception as e:
        p(f"\n[ERROR] {e}")
        sys.exit(1)
    finally:
        ssh.close()


if __name__ == "__main__":
    main()
