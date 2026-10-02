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

**Link:** https://mohdaie.github.io/Musab-AI-agents/ (live once this is on `main` and GitHub Pages is on, see below). Open it on your phone and install it: iPhone *Share → Add to Home Screen*, Android Chrome *Install app*.

The app looks and works like a WhatsApp group chat (dark and light). Your teams, chats and agent memory are saved on your device. The admin login, DeepSeek API keys, settings and usage are on a small server (a Supabase Edge Function), so they're the same on every device and survive app updates, and the keys never reach a phone.

1. **Admin** (shield icon). Sign in with **admin / admin**; the server makes you set your own username and password before anything else. Add your DeepSeek API key.
2. **New team** (green + button): a name, *Team of engineers* or *Group of friends*, how many agents (1 to 12), then a name, designation and expertise or personality for each.
3. **Chat**: a message goes to the group; type `@` to pick one member. "jess is typing…" shows under the group name. Tap the group name to add or remove members, clear the chat or delete the team.

Engineers stay in their own expertise and hand work to each other. Friends chat casually and stay in character.

### Admin page

- **API keys.** Add as many DeepSeek keys as you like. Each shows whether it works, its live balance from DeepSeek, and its requests, tokens and estimated cost. Agents use the active key and move to the next if one is invalid or out of balance.
- **Usage.** Requests, tokens and estimated cost for today, 7 days, 30 days or all time, a 14-day chart, and a breakdown by key, model and agent. Counted by the server for every device.
- **Settings.**
  - *Default talk level for new agents*. Each agent has its own level, **Light** (answers group messages only when it's the most relevant, 1–2 sentences, no thinking), **Balanced** (when among the 2 most relevant, a few sentences) or **Detailed** (always, in depth). Change it any time in the chat: tap the group name and pick the level under the member. Agents you @mention always answer.
  - *Model for engineer teams* and *Model for friend groups*: Pro by default for engineers, Flash (about a third of the price) for friends.
- **Skills.** Playbooks agents follow (checklists, methods, templates), stored on the server.
  - *Add from GitHub*: paste a repo (or a folder in one) and tap **Discover**. Every folder with a `SKILL.md` (the open Agent Skills format) is listed; tick the ones you want and add them. **Check GitHub for updates** pulls newer versions. Private repos need a read-only GitHub token (optional field in the same card).
  - *Write your own*: name, one-line description, instructions.
  - *Give them to agents*: in a chat, tap the group name, then **Skills** under a member. Agents see each skill's name and description and open the full text with a `use_skill` tool only when it fits, so many skills stay cheap. The chat shows "📘 zu is using the skill …". Skills that ship scripts are flagged: agents can't run code, so they follow the written instructions only.
- **Web search.** Paste a [Tavily](https://app.tavily.com) API key (free for 1,000 searches a month); the key stays on the server. Then in a chat tap the group name and switch on **Can browse the web** for the agents who need it. They get two read-only tools, `web_search` (up to 5 results) and `read_page` (one page as text), at most 3 calls per reply. The chat shows "🔎 mike searched the web: …" and "🌐 mike is reading …", and Usage counts searches and pages read.
- **Login.** Change the username and password. Other devices then sign in again.

### Server

`supabase/functions/musab/index.ts` is the server: login (bcrypt password, signed sessions, lockout after repeated wrong passwords), keys, settings, usage, and the DeepSeek relay. Its tables (`app_config`, `api_keys`, `usage`) have row level security with no policies, so only the function can read them. Deploy changes with `supabase functions deploy musab --no-verify-jwt` (the function checks its own sessions).

### Turning on the GitHub link

1. Merge this into `main`.
2. In the repository: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. The *Deploy web app to GitHub Pages* workflow publishes `musab/web/` on every push to `main` that changes it (or run it by hand from the Actions tab).

### Run it locally

```bash
musab serve                 # then open http://localhost:8765
```

### Test it

```bash
npm i -g playwright && node tests/web/e2e.mjs                     # the app, with server and DeepSeek faked
node --experimental-strip-types tests/server/github.test.mjs     # GitHub skill discovery, with GitHub faked
node --experimental-strip-types tests/server/web.test.mjs        # web search and page reading, with Tavily faked
```

This opens the app in a real browser with the server and DeepSeek faked, and goes through the forced password change, keys, settings, teams, chatting, models per team type, usage and members.

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
