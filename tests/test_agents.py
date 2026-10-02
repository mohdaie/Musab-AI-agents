"""Offline tests: a fake LLM stands in for DeepSeek."""
import json
import re
import shutil
import tempfile
import unittest
from pathlib import Path

from musab.agent import Agent, load_roster
from musab.config import Config
from musab.llm import DeepSeek
from musab.store import SHARED, Store

ROOT = Path(__file__).resolve().parents[1]


class FakeLLM:
    """script(name, system, user, messages) -> assistant dict."""

    def __init__(self, script):
        self.script = script
        self.calls = []

    def chat(self, *, model, messages, tools, thinking):
        name = re.match(r"You are (\w[\w-]*),", messages[0]["content"]).group(1)
        self.calls.append((name, messages))
        return self.script(name, messages)


def text(s):
    return {"role": "assistant", "content": s}


def tool(name, **args):
    return {"role": "assistant", "content": "", "reasoning_content": "thinking...",
            "tool_calls": [{"id": "c1", "type": "function",
                            "function": {"name": name, "arguments": json.dumps(args)}}]}


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        shutil.copytree(ROOT / "agents", self.tmp / "agents")
        shutil.copytree(ROOT / "skills", self.tmp / "skills")
        self.cfg = Config.load(self.tmp)
        self.cfg.db_path = self.tmp / "t.db"
        self.cfg.max_hops = 4
        self.store = Store(self.cfg.db_path)

    def tearDown(self):
        self.store.close()
        shutil.rmtree(self.tmp)

    def team(self, llm):
        agents = [Agent(s, self.cfg, llm, Store(self.cfg.db_path), log=lambda *_: None)
                  for s in load_roster(self.cfg.agents_dir).values()]
        for a in agents:
            a.poll_once()  # register cursors
        return agents

    def pump(self, agents, rounds=10):
        for _ in range(rounds):
            if not sum(a.poll_once() for a in agents):
                break


class TestTeam(Base):
    def test_broadcast_everyone_answers_user(self):
        llm = FakeLLM(lambda n, m: text(f"{n} here"))
        agents = self.team(llm)
        self.store.post("user", ["all"], "server is slow")
        self.pump(agents)
        replies = [m for m in self.store.recent() if m.sender != "user"]
        self.assertEqual({m.sender for m in replies}, {"zu", "charles", "mike"})
        self.assertTrue(all(m.recipients == ["user"] for m in replies))

    def test_mention_makes_agents_talk_directly(self):
        def script(n, m):
            if n == "zu":
                return text("Looks like SQL waits. @charles can you check?")
            if n == "charles":
                return text("Confirmed PAGEIOLATCH waits, disk is slow.")
            return text("PASS")
        agents = self.team(FakeLLM(script))
        self.store.post("user", ["zu"], "app timeouts")
        self.pump(agents)
        msgs = self.store.recent()
        zu = next(m for m in msgs if m.sender == "zu")
        self.assertEqual(zu.recipients, ["charles", "user"])
        ch = next(m for m in msgs if m.sender == "charles")
        self.assertEqual(ch.recipients, ["zu"])
        self.assertEqual(ch.thread_id, msgs[0].id)
        # zu answers charles back, charles is not mentioned again -> chain ends
        self.assertEqual(sum(1 for m in msgs if m.sender == "mike"), 0)

    def test_hop_limit_stops_ping_pong(self):
        def script(n, m):
            other = "charles" if n == "zu" else "zu"
            return text(f"I disagree @{other}")
        agents = self.team(FakeLLM(script))
        self.store.post("user", ["zu"], "argue")
        self.pump(agents, rounds=50)
        agent_msgs = [m for m in self.store.recent(100) if m.sender != "user"]
        self.assertLessEqual(max(m.hop for m in agent_msgs), self.cfg.max_hops)
        self.assertLessEqual(len(agent_msgs), self.cfg.max_hops + 1)

    def test_pass_posts_nothing(self):
        agents = self.team(FakeLLM(lambda n, m: text("PASS")))
        self.store.post("user", ["all"], "hello")
        self.pump(agents)
        self.assertEqual(len(self.store.recent()), 1)

    def test_agent_broadcast_is_fyi(self):
        agents = self.team(FakeLLM(lambda n, m: text("reply")))
        self.store.post("zu", ["all"], "FYI: patching tonight")
        self.pump(agents)
        self.assertEqual(len(self.store.recent()), 1)

    def test_send_message_tool(self):
        def script(n, m):
            if n == "mike" and m[-1]["role"] == "user":
                return tool("send_message", to=["zu"], content="check DC01 time sync")
            if n == "mike":
                return text("Asked zu to check time sync.")
            return text("PASS")
        agents = self.team(FakeLLM(script))
        self.store.post("user", ["mike"], "kerberos errors")
        self.pump(agents)
        msgs = self.store.recent()
        side = next(m for m in msgs if m.content == "check DC01 time sync")
        self.assertEqual((side.sender, side.recipients, side.hop), ("mike", ["zu"], 1))

    def test_persistent_memory(self):
        def script(n, m):
            if m[-1]["role"] == "user":
                return tool("remember", content="Prod SQL runs on SQLPRD01")
            return text("noted")
        agents = self.team(FakeLLM(script))
        self.store.post("user", ["charles"], "remember prod is SQLPRD01")
        self.pump(agents)
        # reopen the DB: memory survives, and lands in the next system prompt
        fresh = Store(self.cfg.db_path)
        self.assertEqual([m.content for m in fresh.recall(["charles"], "SQLPRD01")],
                         ["Prod SQL runs on SQLPRD01"])
        seen = []
        llm2 = FakeLLM(lambda n, m: (seen.append(m[0]["content"]), text("ok"))[1])
        ch = Agent(load_roster(self.cfg.agents_dir)["charles"], self.cfg, llm2, fresh,
                   log=lambda *_: None)
        fresh.post("user", ["charles"], "which server is SQLPRD01?")
        ch.poll_once()
        self.assertIn("Prod SQL runs on SQLPRD01", seen[0])
        self.assertEqual(fresh.recall(["zu"], "SQLPRD01"), [])  # private to charles

    def test_shared_memory_and_reasoning_passback(self):
        def script(n, m):
            if m[-1]["role"] == "user":
                return tool("remember", content="Change freeze on Fridays", shared=True)
            # the assistant tool-call turn (with reasoning_content) is sent back
            self.assertEqual(m[-2].get("reasoning_content"), "thinking...")
            return text("saved")
        agents = self.team(FakeLLM(script))
        self.store.post("user", ["zu"], "note the freeze")
        self.pump(agents)
        self.assertEqual(self.store.recall([SHARED], "freeze")[0].content, "Change freeze on Fridays")

    def test_dynamic_new_agent(self):
        llm = FakeLLM(lambda n, m: text(f"{n} ok"))
        agents = self.team(llm)
        (self.cfg.agents_dir / "nina.yaml").write_text(
            "name: nina\nrole: Network engineer\nskills: [critical-review]\n")
        nina = Agent(load_roster(self.cfg.agents_dir)["nina"], self.cfg, llm,
                     Store(self.cfg.db_path), log=lambda *_: None)
        nina.poll_once()
        self.store.post("user", ["all"], "who is here?")
        self.pump(agents + [nina])
        self.assertIn("nina", {m.sender for m in self.store.recent()})
        # existing agents see nina in their team list
        zu_prompt = next(msgs for n, msgs in llm.calls if n == "zu")[0]["content"]
        self.assertIn("@nina: Network engineer", zu_prompt)


class TestDeepSeekPayload(unittest.TestCase):
    def test_request_body(self):
        ds = DeepSeek("sk-test")
        sent = {}

        def fake_post(body):
            sent.update(body)
            return {"choices": [{"message": {"content": "hi", "reasoning_content": "r",
                                             "tool_calls": None}}]}
        ds._post = fake_post
        out = ds.chat(model="deepseek-v4-pro", messages=[{"role": "user", "content": "x"}],
                      tools=[{"type": "function"}], thinking="max")
        self.assertEqual(sent["thinking"], {"type": "enabled"})
        self.assertEqual(sent["reasoning_effort"], "max")
        self.assertEqual(out, {"role": "assistant", "content": "hi", "reasoning_content": "r"})
        ds.chat(model="m", messages=[], tools=None, thinking="off")
        self.assertEqual(sent["thinking"], {"type": "disabled"})


if __name__ == "__main__":
    unittest.main()
