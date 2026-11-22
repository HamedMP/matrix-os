"""Create the platform admin account on the bridge host's Synapse.

Runs inside the Synapse container (stdlib only), started by bootstrap.sh.
Reads {"localpart", "password", "shared_secret"} as JSON on stdin and writes
only the admin access token to stdout. Errors name the Matrix errcode only.
"""
import hashlib, hmac, json, os, sys, urllib.error, urllib.parse, urllib.request

cfg = json.load(sys.stdin)
base = os.environ.get("MBH_SYNAPSE_URL", "http://127.0.0.1:8008")

def call(method, path, body=None, token=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(base + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as err:
        try:
            payload = json.loads(err.read() or b"{}")
        except ValueError:
            payload = {}
        return err.code, payload

user, password, secret = cfg["localpart"], cfg["password"], cfg["shared_secret"]
status, body = call("GET", "/_synapse/admin/v1/register")
if status != 200:
    sys.exit("admin nonce request failed: HTTP %d" % status)
nonce = body["nonce"]
mac = hmac.new(
    secret.encode(),
    b"\x00".join([nonce.encode(), user.encode(), password.encode(), b"admin"]),
    hashlib.sha1,
).hexdigest()
status, body = call("POST", "/_synapse/admin/v1/register",
                    {"nonce": nonce, "username": user, "password": password, "admin": True, "mac": mac})
if status != 200:
    if body.get("errcode") != "M_USER_IN_USE":
        sys.exit("admin registration failed: %s" % body.get("errcode", "HTTP %d" % status))
    status, body = call("POST", "/_matrix/client/v3/login", {
        "type": "m.login.password",
        "identifier": {"type": "m.id.user", "user": user},
        "password": password,
        "initial_device_display_name": "matrix-os-platform",
    })
    if status != 200:
        sys.exit("admin login failed: %s" % body.get("errcode", "HTTP %d" % status))
token, user_id = body["access_token"], body["user_id"]
status, body = call("POST", "/_synapse/admin/v1/users/%s/override_ratelimit" % urllib.parse.quote(user_id),
                    {"messages_per_second": 0, "burst_count": 0}, token)
if status != 200:
    sys.exit("admin rate-limit override failed: %s" % body.get("errcode", "HTTP %d" % status))
sys.stdout.write(token + "\n")
