"""Web UI / API tests: real HTTP server, fake LLM, temp folder."""
import json
import shutil
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

from musab.config import Config
from musab.server import Hub, make_handler

from .test_agents import ROOT, FakeLLM, text


class TestServer(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        shutil.copytree(ROOT / "skills", self.tmp / "skills")
        self.cfg = Config.load(self.tmp)
        self.cfg.teams_dir = self.tmp / "data" / "teams"
        self.cfg.poll_seconds = 0.05
        self.prompts = []

        def script(name, messages):
            self.prompts.append(messages[0]["content"])
            return text(f"hi from {name}")
        self.hub = Hub(self.cfg, FakeLLM(script))
        self.httpd = ThreadingHTTPServer(
            ("127.0.0.1", 0), make_handler(self.hub, token="", allowed_hosts={"127.0.0.1"}))
        self.base = f"http://127.0.0.1:{self.httpd.server_port}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.hub.shutdown()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def call(self, method, path, body=None, headers=None):
        data = json.dumps(body).encode() if body is not None else None
        h = {"Content-Type": "application/json"} if body is not None else {}
        h.update(headers or {})
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def make_team(self, style="work"):
        return self.call("POST", "/api/teams", {
            "name": "IT Ops", "style": style, "agents": [
                {"name": "Zu", "role": "Windows admin", "about": "Event logs first."},
                {"name": "", "role": "DBA", "about": "Careful with prod."}]})

    def wait_for(self, tid, n, timeout=5):
        end = time.time() + timeout
        while time.time() < end:
            _, r = self.call("GET", f"/api/teams/{tid}/messages")
            if len(r["messages"]) >= n:
                return r["messages"]
            time.sleep(0.05)
        self.fail(f"expected {n} messages, got {r['messages']}")

    def test_create_team_and_chat(self):
        st, team = self.make_team()
        self.assertEqual(st, 200)
        self.assertEqual(team["id"], "it-ops")
        self.assertEqual([a["name"] for a in team["agents"]], ["agent2", "zu"])
        self.assertTrue((self.cfg.teams_dir / "it-ops" / "agents" / "zu.yaml").exists())

        st, m = self.call("POST", "/api/teams/it-ops/messages", {"content": "server is slow"})
        self.assertEqual((st, m["recipients"]), (200, ["all"]))
        msgs = self.wait_for("it-ops", 3)
        self.assertEqual({m["sender"] for m in msgs[1:]}, {"zu", "agent2"})
        self.assertIn("Event logs first.", "\n".join(self.prompts))
        self.assertIn("(IT Ops)", self.prompts[0])

        # @mention goes to one agent only
        self.call("POST", "/api/teams/it-ops/messages", {"content": "@zu just you"})
        msgs = self.wait_for("it-ops", 5)
        self.assertEqual(msgs[3]["recipients"], ["zu"])
        self.assertEqual(msgs[4]["sender"], "zu")

        _, after = self.call("GET", f"/api/teams/it-ops/messages?after={msgs[3]['id']}")
        self.assertEqual([m["id"] for m in after["messages"]], [msgs[4]["id"]])
        _, teams = self.call("GET", "/api/teams")
        self.assertEqual(teams[0]["last_message"]["sender"], "zu")

    def test_friends_style_prompt(self):
        _, team = self.make_team("friends")
        self.call("POST", f"/api/teams/{team['id']}/messages", {"content": "hey"})
        self.wait_for(team["id"], 3)
        self.assertIn("group of friends", self.prompts[0])
        self.assertNotIn("Stay inside your own expertise", self.prompts[0])

    def test_validation(self):
        bad = [
            {"name": "", "style": "work", "agents": [{"role": "x"}]},
            {"name": "t", "style": "boss", "agents": [{"role": "x"}]},
            {"name": "t", "style": "work", "agents": []},
            {"name": "t", "style": "work", "agents": [{"name": "a", "role": ""}]},
            {"name": "t", "style": "work", "agents": [{"name": "a", "role": "x"}, {"name": "A", "role": "y"}]},
            {"name": "t", "style": "work", "agents": [{"name": "user", "role": "x"}]},
        ]
        for body in bad:
            st, r = self.call("POST", "/api/teams", body)
            self.assertEqual(st, 400, body)
            self.assertIn("error", r)
        self.make_team()
        st, r = self.call("POST", "/api/teams/it-ops/messages", {"content": "@nobody hi"})
        self.assertEqual(st, 400)
        self.assertEqual(self.call("GET", "/api/teams/../../etc")[0], 404)
        self.assertEqual(self.call("GET", "/api/teams/nope/messages")[0], 404)

    def test_same_name_gets_new_id_and_delete(self):
        self.make_team()
        _, t2 = self.make_team()
        self.assertEqual(t2["id"], "it-ops-2")
        self.assertEqual(self.call("DELETE", "/api/teams/it-ops-2")[0], 200)
        self.assertFalse((self.cfg.teams_dir / "it-ops-2").exists())
        _, teams = self.call("GET", "/api/teams")
        self.assertEqual([t["id"] for t in teams], ["it-ops"])

    def test_agent_error_shows_in_chat(self):
        def boom(name, messages):
            raise RuntimeError("DeepSeek HTTP 401: bad key")
        self.hub.llm = FakeLLM(boom)
        self.make_team()
        self.call("POST", "/api/teams/it-ops/messages", {"content": "@zu hi"})
        msgs = self.wait_for("it-ops", 2)
        self.assertEqual(msgs[1]["sender"], "system")
        self.assertIn("bad key", msgs[1]["content"])

    def test_static_and_guards(self):
        with urllib.request.urlopen(self.base + "/manifest.webmanifest") as r:
            self.assertIn("manifest+json", r.headers["Content-Type"])
            self.assertEqual(json.loads(r.read())["display"], "standalone")
        with urllib.request.urlopen(self.base + "/team/whatever") as r:  # SPA fallback
            self.assertIn(b"<main id=\"app\"", r.read())
        st, _ = self.call("GET", "/api/status", headers={"Host": "evil.example"})
        self.assertEqual(st, 403)
        req = urllib.request.Request(self.base + "/api/teams", data=b"name=x", method="POST",
                                     headers={"Content-Type": "application/x-www-form-urlencoded"})
        with self.assertRaises(urllib.error.HTTPError) as cm:
            urllib.request.urlopen(req)
        self.assertEqual(cm.exception.code, 415)

    def test_token(self):
        self.httpd.RequestHandlerClass = make_handler(self.hub, token="s3cret")
        self.assertEqual(self.call("GET", "/api/status")[0], 401)
        st, s = self.call("GET", "/api/status", headers={"Authorization": "Bearer s3cret"})
        self.assertEqual((st, s["llm"]), (200, True))

    def test_cli_team_option(self):
        self.make_team()
        cfg = Config.load(self.tmp)
        cfg.teams_dir = self.cfg.teams_dir
        t = cfg.for_team("it-ops")
        self.assertEqual((t.team_name, t.team_style), ("IT Ops", "work"))
        self.assertEqual(t.agents_dir, self.cfg.teams_dir / "it-ops" / "agents")
        with self.assertRaises(ValueError):
            cfg.for_team("../x")


if __name__ == "__main__":
    unittest.main()
