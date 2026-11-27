#!/usr/bin/env python3
import argparse
import base64
import json
import os
import pathlib
import subprocess
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


DEFAULT_OUTPUT_LIMIT = 1024 * 1024
MAX_COMMAND_OUTPUT_LIMIT = 16 * 1024 * 1024
MAX_FILE_READ_OUTPUT_LIMIT = 500 * 1024 * 1024
DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024


def resolve_max_body_bytes():
    raw = os.environ.get("DATAOPS_WORKSPACE_HELPER_MAX_BODY_BYTES", "").strip()
    if not raw:
        return DEFAULT_MAX_BODY_BYTES
    try:
        value = int(raw)
    except ValueError:
        return DEFAULT_MAX_BODY_BYTES
    return value if value > 0 else DEFAULT_MAX_BODY_BYTES


MAX_BODY_BYTES = resolve_max_body_bytes()


class HelperError(Exception):
    def __init__(self, code, message, status=400):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


def read_json(handler):
    length = int(handler.headers.get("content-length") or "0")
    if length < 0 or length > MAX_BODY_BYTES:
        raise HelperError("OUTPUT_TOO_LARGE", "request body too large", 413)
    raw = handler.rfile.read(length)
    try:
        body = json.loads(raw.decode("utf-8") or "{}")
    except Exception as exc:
        raise HelperError("INVALID_PATH_OPERATION", "invalid json request", 400) from exc
    if not isinstance(body, dict):
        raise HelperError("INVALID_PATH_OPERATION", "request body must be object", 400)
    return body


def write_json(handler, status, body):
    payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("content-type", "application/json; charset=utf-8")
    handler.send_header("content-length", str(len(payload)))
    handler.end_headers()
    handler.wfile.write(payload)


def require_string(body, key):
    value = body.get(key)
    if not isinstance(value, str) or not value:
        raise HelperError("INVALID_PATH_OPERATION", f"{key} must be non-empty string")
    return value


# 命令与文件读取共享参数格式，但由各自调用点传入不同硬上限，避免文件预算放大命令输出。
def optional_output_limit(body, maximum=MAX_COMMAND_OUTPUT_LIMIT):
    value = body.get("maxOutputBytes", DEFAULT_OUTPUT_LIMIT)
    if not isinstance(value, int) or value <= 0:
        return DEFAULT_OUTPUT_LIMIT
    return min(value, maximum)


def path_arg(body):
    return pathlib.Path(require_string(body, "path"))


def encode_bytes(value):
    return base64.b64encode(value).decode("ascii")


class WorkspaceHelperHandler(BaseHTTPRequestHandler):
    server_version = "DataOpsWorkspaceHelper/1.0"

    def log_message(self, fmt, *args):
        return

    def do_GET(self):
        if self.path == "/health":
            write_json(self, 200, {"ok": True, "status": "ready"})
            return
        write_json(self, 404, {"ok": False, "code": "PATH_NOT_FOUND", "message": "unknown endpoint"})

    def do_POST(self):
        try:
            body = read_json(self)
            if self.path == "/execute":
                response = self.handle_execute(body)
            elif self.path == "/files/read":
                response = self.handle_read(body)
            elif self.path == "/files/list":
                response = self.handle_list(body)
            elif self.path == "/files/write":
                response = self.handle_write(body)
            else:
                raise HelperError("PATH_NOT_FOUND", f"unknown endpoint: {self.path}", 404)
            write_json(self, 200, {"ok": True, **response})
        except HelperError as exc:
            write_json(self, exc.status, {"ok": False, "code": exc.code, "message": exc.message})
        except Exception as exc:
            write_json(self, 500, {"ok": False, "code": "DOCKER_COMMAND_FAILED", "message": str(exc)})

    def handle_execute(self, body):
        command = require_string(body, "command")
        cwd = require_string(body, "cwd")
        timeout = body.get("timeoutSeconds", 20)
        if not isinstance(timeout, (int, float)) or timeout <= 0:
            timeout = 20
        timeout = min(float(timeout), 300.0)
        max_output = optional_output_limit(body)
        env = os.environ.copy()
        request_env = body.get("env")
        if isinstance(request_env, dict):
            for key, value in request_env.items():
                if isinstance(key, str) and isinstance(value, str):
                    env[key] = value
        stdin_base64 = body.get("stdinBase64")
        stdin = None
        if isinstance(stdin_base64, str) and stdin_base64:
            stdin = base64.b64decode(stdin_base64.encode("ascii"))

        with self.server.semaphore:
            try:
                completed = subprocess.run(
                    ["/bin/sh", "-c", command],
                    input=stdin,
                    cwd=cwd,
                    env=env,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    timeout=timeout,
                    check=False,
                )
            except subprocess.TimeoutExpired as exc:
                stdout = exc.stdout or b""
                stderr = (exc.stderr or b"") + f"\ncommand timed out after {timeout:g}s".encode("utf-8")
                return {
                    "exitCode": 124,
                    "stdoutBase64": encode_bytes(stdout[:max_output]),
                    "stderrBase64": encode_bytes(stderr[:max_output]),
                }

        if len(completed.stdout) > max_output or len(completed.stderr) > max_output:
            raise HelperError("OUTPUT_TOO_LARGE", "command output too large", 413)
        return {
            "exitCode": completed.returncode,
            "stdoutBase64": encode_bytes(completed.stdout),
            "stderrBase64": encode_bytes(completed.stderr),
        }

    def handle_read(self, body):
        # 先按 stat 拒绝明显超限文件，读取后再校验一次以覆盖检查期间文件增长。
        target = path_arg(body)
        if not target.exists():
            raise HelperError("FILE_NOT_FOUND", f"workspace file not found: {target}", 404)
        if not target.is_file():
            raise HelperError("PATH_NOT_FILE", f"workspace path is not file: {target}")
        max_output = optional_output_limit(body, MAX_FILE_READ_OUTPUT_LIMIT)
        if target.stat().st_size > max_output:
            raise HelperError("OUTPUT_TOO_LARGE", "file output too large", 413)
        with target.open("rb") as source:
            data = source.read(max_output + 1)
        if len(data) > max_output:
            raise HelperError("OUTPUT_TOO_LARGE", "file output too large", 413)
        return {"contentBase64": encode_bytes(data)}

    def handle_list(self, body):
        target = path_arg(body)
        if not target.exists():
            raise HelperError("DIRECTORY_NOT_FOUND", f"workspace directory not found: {target}", 404)
        if not target.is_dir():
            raise HelperError("PATH_NOT_DIRECTORY", f"workspace path is not directory: {target}")
        entries = []
        for child in target.iterdir():
            stat = child.stat()
            modified = datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat().replace("+00:00", "Z")
            entries.append({
                "name": child.name,
                "isDir": child.is_dir(),
                "size": 0 if child.is_dir() else stat.st_size,
                "modifiedAt": modified,
            })
        entries.sort(key=lambda item: (not item["isDir"], item["name"].lower()))
        return {"entries": entries}

    def handle_write(self, body):
        items = body.get("files")
        if not isinstance(items, list):
            raise HelperError("INVALID_PATH_OPERATION", "files must be array")
        for item in items:
            if not isinstance(item, dict):
                raise HelperError("INVALID_PATH_OPERATION", "file item must be object")
            target = pathlib.Path(require_string(item, "path"))
            content_base64 = require_string(item, "contentBase64")
            data = base64.b64decode(content_base64.encode("ascii"))
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        return {}


class WorkspaceHelperServer(ThreadingHTTPServer):
    def __init__(self, server_address, handler_cls, max_concurrent):
        super().__init__(server_address, handler_cls)
        self.semaphore = threading.BoundedSemaphore(max_concurrent)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=os.environ.get("DATAOPS_WORKSPACE_HELPER_HOST", "0.0.0.0"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("DATAOPS_WORKSPACE_HELPER_PORT", "43117")))
    parser.add_argument("--max-concurrent", type=int, default=int(os.environ.get("DATAOPS_WORKSPACE_HELPER_MAX_CONCURRENT", "4")))
    args = parser.parse_args()
    server = WorkspaceHelperServer((args.host, args.port), WorkspaceHelperHandler, max(1, args.max_concurrent))
    server.serve_forever()


if __name__ == "__main__":
    main()
