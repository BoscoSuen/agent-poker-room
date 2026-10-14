"""Tiny HTTP sidecar around pokerskill_agent.generate_prompt (stdlib only, py3.9)."""
import json, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pokerskill_agent import generate_prompt
from pokerskill_agent.schema import validate_game_state, ValidationError

class H(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def do_GET(self):
        self._send(200, {"ok": True})
    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        try:
            raw = json.loads(self.rfile.read(n) or b"{}")
            st = validate_game_state(raw)
            t = time.time()
            p = generate_prompt(st)
            self._send(200, {"system_prompt": p["system_prompt"], "user_prompt": p["user_prompt"], "ms": round((time.time() - t) * 1000, 1)})
        except ValidationError as e:
            self._send(400, {"error": "validation", "message": str(e)})
        except Exception as e:  # noqa
            self._send(500, {"error": "internal", "message": str(e)})
    def log_message(self, *a):
        pass

if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8321), H).serve_forever()
