# Musab-AI-agents

A team of independent AI agents running on the DeepSeek API. You can add as many as you like. Each agent has its own role, skills, model and persistent memory, and they talk to each other directly. No central AI routes the messages.

```
            ┌──────────── shared bus (SQLite) ────────────┐
 user ──▶   │  messages  ·  per-agent cursors  ·  memory  │
            └──▲─────────────▲─────────────▲──────────────┘
               │             │             │
             @zu         @charles        @mike      ← each has its own loop,
          Windows infra     DBA        AD expert      prompt, skills, memory
```

- **Dynamic team.** One YAML file in `agents/` is one agent. Add a file while `musab run` is running and the new agent comes online within about 10 seconds.
- **Own skillset.** Each agent loads only the skill files listed in its YAML (`skills/*.md`).
- **Direct agent-to-agent talk.** An agent pulls another in by writing `@name` in its reply, or by calling the `send_message` tool. The other agent replies straight back to it.
- **Persistent memory.** Each agent can `remember`, `recall` and `forget` facts, either private to itself or shared with the team. Memory is stored in SQLite with full-text search and survives restarts. The relevant memories are added to every prompt automatically.
- **Loop guard.** Agent-to-agent chains stop after `MUSAB_MAX_HOPS` replies in a thread. An agent replies `PASS` when it has nothing to add.

## Setup

Requires Python 3.10+.

```bash
git clone https://github.com/mohdaie/Musab-AI-agents && cd Musab-AI-agents
pip install -e .            # only dependency: PyYAML
cp .env.example .env        # put your DeepSeek key in DEEPSEEK_API_KEY
```

### Model

| `DEEPSEEK_MODEL` | What it is |
|---|---|
| `deepseek-v4-pro` (default) | DeepSeek V4 Pro, the strongest model |
| `deepseek-flash` | DeepSeek V4.1 Flash, much cheaper and faster |

You can override the model per agent with `model:` in its YAML, so you can mix the two models, for example Flash for a reviewer agent and Pro for the rest. Thinking effort is set per agent with `thinking: off | low | high | max`.

## Web app (PWA)

```bash
musab serve                 # then open http://localhost:8765
```

The app walks you through it:

1. **Create a team**: give it a name and pick *Team of engineers* or *Group of friends*.
2. **How many agents**: 1 to 12.
3. **Agent #1, #2, ...**: a name (their `@handle`), a designation (e.g. "Database administrator" or "The joker"), and what they're expert at or their personality. *Fill with examples* fills it in for you.
4. **Chat room**: the team is saved and you land in a group chat with all of them. A message goes to everyone; tap a name (or start with `@name`) to talk to one agent. You can see who is typing and when agents talk to each other (`zu → @charles`).

Engineers stay in their own expertise and hand work to each other. Friends chat casually, stay in character and answer more quickly (`thinking: low`).

`musab serve` runs the agents of every team itself, so you don't need `musab run`. Each team is saved in `data/teams/<team>/` (`team.yaml`, `agents/*.yaml`, its own `musab.db` with chat history and memory). You can still edit the YAML files by hand, or use the CLI on a team with `--team`, e.g. `musab --team it-ops memory zu`.

**On your phone.** Open it from your phone on the same Wi-Fi with a token so nobody else can use your DeepSeek credits:

```bash
musab serve --host 0.0.0.0 --token pick-a-secret
# on the phone: http://<your-pc-ip>:8765/?token=pick-a-secret
```

iPhone: *Share → Add to Home Screen*. Android Chrome only offers *Install app* on HTTPS (or localhost), so put it behind HTTPS, for example `tailscale serve 8765` or a Cloudflare tunnel. Over plain HTTP it still works in the browser.

## Use (command line)

```bash
musab run                   # start all agents (terminal 1)
musab chat                  # talk to them (terminal 2)
```

In `chat`:

```
the file server FS01 is slow and users get login errors     → to all agents
@mike users can't log in to FS01                             → only mike
@zu @charles is the SQL box swapping?                        → zu and charles
```

The agents then message each other on their own, for example `zu → @charles: check wait stats`.

Other commands:

```bash
musab agents                                   # list the team
musab new-agent nina --role "Network engineer" --skills networking,critical-review
musab say "@charles check backups" --to all    # one-off message
musab log [--thread 12]                        # bus history
musab memory charles [--search sqlprd]         # an agent's memory
musab memory team --add "Change freeze on Fridays"
musab run --only zu                            # run one agent per terminal/machine
```

You can spread agents across separate terminals or machines. Every process just needs to point at the same `MUSAB_DB` file.

## Agent file

`agents/zu.yaml`:

```yaml
name: zu
role: Windows infrastructure admin
thinking: high              # off | low | high | max
# model: deepseek-flash     # optional per-agent override
skills:
  - windows-infra           # loads skills/windows-infra.md
  - critical-review
persona: |
  Practical, terse sysadmin. Asks for the exact error text before guessing.
```

To take an agent off the team without deleting its file, set `enabled: false`.

## How an agent decides to act

| Message | Reacts? |
|---|---|
| Addressed to it by name | Yes, up to `MUSAB_MAX_HOPS` agent-to-agent hops |
| Broadcast to `all` from the user | Yes |
| Broadcast to `all` from another agent | No (it is for information only) |
| Its own message | No |

Its reply goes to the sender, plus any agents it mentions with `@name`.

## Tests

```bash
python -m unittest -v
```

The tests run offline with a fake LLM.
