# Voice and TURN

Voice is peer to peer: every pair of participants who joined the call opens a WebRTC connection
(audio only, a mesh — fine for meeting-sized groups). The server only relays the signalling
messages. Browsers first try a direct connection with the help of STUN; when firewalls or
symmetric NATs block that — common in corporate networks and on mobile data — they need a
**TURN** server to relay the audio.

## Configure TURN

```yaml
voice:
  turn:
    urls:
      - turn:turn.acme.example:3478?transport=udp
      - turn:turn.acme.example:3478?transport=tcp
      - turns:turn.acme.example:443?transport=tcp     # for networks that only allow 443
    secretEnv: TURN_SECRET      # environment variable with the shared secret
    ttlSeconds: 3600
```

With Helm, give the secret through `turn.existingSecret` (key `turn-secret`).

The server never hands out the shared secret. After a participant joins a room it sends them
**short-lived credentials** (the "TURN REST API" scheme understood by coturn's
`use-auth-secret` and STUNner's `ephemeral` auth):

```
username   = "<unix expiry time>:<participant id>"
credential = base64(HMAC-SHA1(shared secret, username))
```

and refreshes them before they expire. Credentials are only issued to people in a room, so the
TURN server cannot be used as an open relay.

## Where to run TURN

TURN needs a public (or company-routable) IP address and UDP ports, which a normal HTTP ingress
cannot provide. Options:

| | |
|---|---|
| **Managed TURN** (e.g. Cloudflare Calls TURN, Twilio, Xirsys) | nothing to operate; check their auth scheme (static credentials go in `voice.iceServers`) |
| **[STUNner](https://github.com/l7mp/stunner)** | Kubernetes-native TURN gateway; one UDP port behind a `LoadBalancer` Service, configured with Gateway API resources; supports the ephemeral auth above |
| **coturn on VMs or nodes with public IPs** | classic; `hostNetwork: true` DaemonSet or VMs, open UDP 3478 and the relay port range |

### coturn essentials

```
use-auth-secret
static-auth-secret=<same value as TURN_SECRET>
realm=acme.example
listening-port=3478
min-port=49152
max-port=65535
external-ip=<public IP>
fingerprint
no-cli
# never relay into private or metadata networks
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
```

`docker compose --profile turn up` starts a local coturn for experiments
(see [`compose.yaml`](../compose.yaml)).

## Disabling voice

`voice.enabled: false` turns it off everywhere; `rules.voice.enabled: false` turns it off for a
room (hosts can also toggle it in **Room settings**). The server then stops relaying signalling.
