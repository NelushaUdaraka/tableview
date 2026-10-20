# Connecting through an AWS bastion (SSM)

Pick *AWS SSM* on the connection's Tunnel tab instead of running the CLI by hand. The session starts
when you connect and is torn down when you disconnect — including the `session-manager-plugin`
grandchild, which on Windows has to be killed as a process tree or it keeps holding the local port.

- **Forward to a remote host** — the bastion relays to an RDS endpoint or another internal listener.
  Uses `AWS-StartPortForwardingSessionToRemoteHost`; the Server field is resolved *from the bastion*.
- **Forward to the instance itself** — SQL Server runs on the bastion. Uses
  `AWS-StartPortForwardingSession`.

## Choosing the bastion

**Picking the bastion.** An instance ID is not a durable setting: a redeploy replaces the bastion
and the saved ID quietly points at something that no longer exists. So once the credentials are in
place and a region is chosen, **Fetch instances** lists what is actually there and the ID becomes a
choice from a list:

```
prod-bastion — i-0ba5711000fee1dad · running · 10.0.2.11 · SSM Online
old-bastion  — i-0dead00beef001122 · running · 10.0.2.12 · SSM ConnectionLost
app-server   — i-0abc123def4567890 · running · 10.0.3.40 · not in SSM
```

Two calls stand behind it — `ec2 describe-instances` for what exists, with Name tags and state, and
`ssm describe-instance-information` for what Session Manager can reach, which is what decides
whether a session can start at all. The reachable ones sort first, `mi-` managed instances that are
not EC2 are included, and either call being denied by IAM degrades to the other's list with a note
rather than to nothing. Reopen a saved connection, fetch, and an ID the region no longer knows about
is called out as replaced.

**Or name it, and stop picking.** *Find the bastion by* switches the connection from an ID to the
instance's **Name tag**, which is the half of the pair that survives a redeploy. Nothing is stored
but the name; the ID is looked up each time the connection opens, so an instance replaced overnight
needs no edit in the morning. The form still lists the account's instances — picking one fills the
name in — and shows what the name resolves to right now:

```
Find the bastion by  [ Name tag ▾ ]   Bastion name  [ prod-bastion ]

“prod-bastion” is i-0ba5711000fee1dad · running · 10.0.2.11 · SSM Online
```

EC2 does the matching, so its `*` wildcards work (`prod-bastion-*`), and filtering there rather than
over the answer is what keeps a large account from cutting the bastion off the end of the list.
Where several instances answer to one name — an autoscaled pair, a half-finished replacement — the
one Systems Manager can reach is used, and that second lookup only runs when there is something to
decide. Nothing answering to the name, or nothing running, fails the connection with that sentence
rather than with a session timeout.

The list is per region, so the region field is the one that has to be right; it is prefilled from
the pasted block when that names one. You can still type an ID by hand — the field stays editable,
and the picker only fills it in.

## Local port and prerequisites

Set a fixed local port (blank picks a free one) and an explicit CLI path if you need them.
**Check prerequisites** verifies the three things that actually go wrong — the AWS CLI, the Session
Manager plugin, and whether your credentials are still valid — and `aws sts get-caller-identity`
confirms which identity you are about to connect as.

## Credentials

Two sources, chosen per connection:

- **Paste them into the app** (the default). Copy the block straight out of the AWS access portal
  and paste it in — bash `export`, PowerShell `$Env:`, cmd `set`, or a credentials-file stanza are
  all accepted, quotes and stray semicolons included. **Paste from clipboard** beside the box does
  it in one click, in the connection form and in the dialog that asks for fresh credentials when
  they run out. The clipboard is read in the main process and only a credentials block is handed to
  the window: with anything else copied — a password, a paragraph — the box stays empty and says
  why. However the block got there, the line under the box shows what it holds as soon as it is in
  (`ASIA************MPLE · eu-west-2 · temporary`), or what is wrong with it, rather than leaving
  that to Save. The block is **saved with that connection**, encrypted by the same vault that
  protects database passwords, so connections in different AWS accounts each carry their own.
  Re-paste when they expire.
- **Let the AWS CLI resolve them** — the normal chain: `--profile`, environment variables, SSO
  cache, `credential_process`, assume-role, instance profile. Use this if you keep profiles in
  `~/.aws/`.

Only a masked summary (`ASIA****…MPLE · eu-west-2 · temporary`) ever reaches the renderer; the
secret and session token stay in the main process. The app never *derives* credentials: it either
passes through what you pasted, as environment variables on the CLI child, or stays out of the way
entirely. Pasted credentials take precedence over anything inherited, so a stale `AWS_PROFILE` in
the app's environment cannot quietly win, and `--profile` is suppressed for them.

## When it goes wrong

Failures are translated rather than passed through: a missing plugin, `TargetNotConnected`, an IAM
denial, an expired SSO session, a bad profile or a busy port each produce a specific instruction
instead of an exit code.

**A destination the session cannot reach** is the one failure that does not announce itself at
startup. Session Manager binds the local port before anything is dialled at the far end, so a
bastion without SQL Server on it, or an RDS endpoint its security group will not let it reach, looks
like a healthy session until the first byte moves — and then the driver reports nothing but
`Connection lost - socket hang up`. So the CLI's output is watched for the whole life of the session,
not just at exit (`Connection to destination port failed`, `Unable to dial connection to port`), the
message is given a moment to arrive after the driver has already given up, and the advice names the
topology in use: the remote host and its security group, the "Forward to" setting when the port was
dialled on the bastion itself, or — for a relayed `localhost`, which the *bastion* resolves and so
forwards to itself — the Server field. The connection form flags that last one before you connect. A drop the CLI never explains says so plainly rather than passing
on the driver's wording.

Readiness comes from the plugin's own `Waiting for connections` banner rather than a probe
connection, because `AWS-StartPortForwardingSession` carries one client at a time and a probe that
connects and hangs up can leave the far side torn down for the connection that follows.

## Requirements

Requires AWS CLI v2 and the Session Manager plugin on the machine running the app, and
`ssm:StartSession` permission on the instance and the port-forwarding document. The instance picker
additionally uses `ec2:DescribeInstances` and `ssm:DescribeInstanceInformation`; neither is needed to
connect, and holding only one of them still produces a usable list.
