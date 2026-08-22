# -*- coding: utf-8 -*-
"""
采购单汇总台 — 本地启动器
双击「启动.bat」，或命令行运行： python serve.py
会自动开浏览器；局域网内手机可用打印出来的第二个地址访问（方便直接拍照上传）。
"""
import http.server
import socketserver
import socket
import os
import sys
import threading
import webbrowser
import json
import urllib.request
import urllib.error

PORT = int(os.environ.get("PORT", "8777"))
ROOT = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self):
        # 为 /proxy 预检请求返回 CORS 头
        if self.path == "/proxy":
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Target-Url, Authorization")
            self.end_headers()
        else:
            super().do_OPTIONS()

    def do_POST(self):
        if self.path == "/proxy":
            self._handle_proxy()
            return
        super().do_POST()

    def _handle_proxy(self):
        try:
            content_len = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_len) if content_len > 0 else b""
            target = self.headers.get("X-Target-Url", "").strip()

            # 兼容：也支持从 JSON body 里读 target
            if not target and body:
                try:
                    payload = json.loads(body.decode("utf-8"))
                    target = payload.get("__proxy_target", "")
                except Exception:
                    pass

            if not target:
                self._send_json(400, {"error": "缺少 X-Target-Url 或 __proxy_target"})
                return

            # 安全限制：只允许转发到百炼/通义千问/智谱等已知的 OpenAI 兼容接口
            allowed_hosts = ("dashscope.aliyuncs.com", "open.bigmodel.cn", "api.openai.com",
                             "api.moonshot.cn", "api.siliconflow.cn")
            if not any(h in target for h in allowed_hosts):
                self._send_json(403, {"error": "目标地址不在白名单内"})
                return

            req = urllib.request.Request(
                target,
                data=body,
                headers={
                    "Content-Type": self.headers.get("Content-Type", "application/json"),
                    "Authorization": self.headers.get("Authorization", ""),
                },
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=120) as resp:
                resp_body = resp.read()
                self.send_response(resp.status)
                self.send_header("Content-Type", resp.headers.get("Content-Type", "application/json"))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(resp_body)
        except urllib.error.HTTPError as e:
            self._send_json(e.code, {"error": e.reason, "message": e.read().decode("utf-8", "ignore")[:500]})
        except Exception as e:
            self._send_json(502, {"error": str(e)})

    def _send_json(self, code, obj):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        pass


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("223.5.5.5", 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


class Reuse(socketserver.TCPServer):
    allow_reuse_address = True


def main():
    global PORT
    for p in range(PORT, PORT + 20):
        try:
            httpd = Reuse(("0.0.0.0", p), Handler)
            PORT = p
            break
        except OSError:
            continue
    else:
        print("端口都被占用了，换个端口试试：set PORT=9000 && python serve.py")
        return

    local = f"http://127.0.0.1:{PORT}/"
    lan = f"http://{lan_ip()}:{PORT}/"
    print("=" * 52)
    print("  采购单汇总台已启动")
    print("=" * 52)
    print(f"  本机访问：{local}")
    print(f"  手机访问：{lan}   （需与电脑同一 WiFi）")
    print()
    print("  数据保存在浏览器本地，关掉窗口不会丢。")
    print("  停止服务：在此窗口按 Ctrl+C")
    print("=" * 52)
    threading.Timer(0.8, lambda: webbrowser.open(local)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")


if __name__ == "__main__":
    main()
