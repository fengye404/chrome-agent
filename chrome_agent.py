#!/usr/bin/env python3
"""Local CLI and Chrome Native Messaging host."""
import argparse
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import queue
import socket
import stat
import struct
import sys
import threading
import time

ROOT = Path(__file__).resolve().parent
STATE_DIR = Path.home() / ".chrome-agent"
SOCKET = STATE_DIR / "bridge.sock"
HOST_NAME = "com.chrome_agent.bridge"
HOST_FILE = Path.home() / "Library/Application Support/Google/Chrome/NativeMessagingHosts" / (HOST_NAME + ".json")
LIMIT = 256 * 1024
TIMEOUT = 12
MEDIA = {".mp4", ".mov", ".m4v", ".jpg", ".jpeg", ".png", ".webp"}


def extension_origin():
    key = json.loads((ROOT / "extension/manifest.json").read_text())["key"]
    digest = hashlib.sha256(base64.b64decode(key)).hexdigest()[:32]
    extension_id = "".join(chr(ord("a") + int(digit, 16)) for digit in digest)
    return f"chrome-extension://{extension_id}/"


def host_config():
    return {
        "name": HOST_NAME,
        "description": "Chrome Agent local bridge",
        "path": str(ROOT / "native-host"),
        "type": "stdio",
        "allowed_origins": [extension_origin()],
    }


def install():
    HOST_FILE.parent.mkdir(parents=True, exist_ok=True)
    config = host_config()
    try:
        with HOST_FILE.open("x") as stream:
            json.dump(config, stream, indent=2)
            stream.write("\n")
    except FileExistsError:
        if json.loads(HOST_FILE.read_text()) != config:
            raise ValueError(f"Existing registration points elsewhere: {HOST_FILE}")
    print(f"Native host registered: {HOST_FILE}")
    print(f"Load unpacked in Chrome: {ROOT / 'extension'}")


def uninstall():
    if HOST_FILE.exists():
        if json.loads(HOST_FILE.read_text()) != host_config():
            raise ValueError(f"Existing registration points elsewhere: {HOST_FILE}")
        HOST_FILE.unlink()
    print("Native host unregistered. Remove Chrome Agent from chrome://extensions.")


def encode(message):
    payload = json.dumps(message, ensure_ascii=False).encode("utf-8")
    if len(payload) > LIMIT:
        raise ValueError("Message exceeds size limit")
    return payload


def send_to_chrome(message):
    payload = encode(message)
    sys.stdout.buffer.write(struct.pack("=I", len(payload)) + payload)
    sys.stdout.buffer.flush()


def read_exact(size):
    payload = bytearray()
    while len(payload) < size:
        chunk = os.read(sys.stdin.fileno(), size - len(payload))
        if not chunk:
            break
        payload.extend(chunk)
    return payload


def read_chrome(output, closed):
    try:
        while True:
            header = read_exact(4)
            if len(header) != 4:
                return
            (size,) = struct.unpack("=I", header)
            if not 0 < size <= LIMIT:
                return
            payload = read_exact(size)
            if len(payload) != size:
                return
            output.put_nowait(json.loads(payload))
    except (ValueError, OSError, queue.Full):
        pass
    finally:
        closed.set()


def receive_line(connection):
    with connection.makefile("rb") as stream:
        line = stream.readline(LIMIT + 1)
    if not line.endswith(b"\n") or len(line) > LIMIT:
        raise ValueError("Invalid local request or response")
    return json.loads(line)


def validated_request(request):
    if not isinstance(request, dict):
        raise ValueError("Invalid request")
    action = request.get("action")
    if action == "inspect":
        return {"action": action}
    if action not in ("fill", "select-file"):
        raise ValueError("Unknown command")
    selector = request.get("selector")
    if not isinstance(selector, str) or not 0 < len(selector) <= 512:
        raise ValueError("Specify a unique CSS selector of at most 512 characters")
    if action == "fill":
        value = request.get("value")
        if not isinstance(value, str) or len(value) > 20000:
            raise ValueError("Text must be at most 20,000 characters")
        return {"action": action, "selector": selector, "value": value}
    filename = request.get("path")
    if not isinstance(filename, str) or not Path(filename).is_absolute():
        raise ValueError("Specify an absolute media path")
    path = Path(filename).resolve(strict=True)
    if not path.is_file() or path.suffix.lower() not in MEDIA:
        raise ValueError("Select an existing MP4, MOV, M4V, JPEG, PNG, or WebP file")
    return {"action": action, "selector": selector, "path": str(path)}


def serve(connection, responses, closed):
    connection.settimeout(2)
    try:
        request = validated_request(receive_line(connection))
    except (ValueError, OSError) as error:
        response = {"ok": False, "error": str(error)}
    else:
        send_to_chrome(request)
        deadline = time.monotonic() + TIMEOUT
        while True:
            if closed.is_set() or time.monotonic() >= deadline:
                raise ConnectionError("Chrome disconnected or timed out")
            try:
                response = responses.get(timeout=0.2)
                break
            except queue.Empty:
                continue
    try:
        connection.sendall(encode(response) + b"\n")
    except OSError:
        pass


def host(origin):
    if origin != extension_origin():
        raise ValueError("Unknown Chrome extension origin")
    os.umask(0o077)
    STATE_DIR.mkdir(mode=0o700, exist_ok=True)
    metadata = STATE_DIR.lstat()
    if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.getuid() or metadata.st_mode & 0o077:
        raise ValueError("~/.chrome-agent must be a private directory owned by your user")
    with (STATE_DIR / "bridge.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ValueError("A Chrome Agent session is already connected") from error
        if SOCKET.is_socket():
            SOCKET.unlink()
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
            server.bind(str(SOCKET))
            try:
                server.listen(1)
                server.settimeout(0.25)
                responses = queue.Queue(maxsize=1)
                closed = threading.Event()
                threading.Thread(target=read_chrome, args=(responses, closed), daemon=True).start()
                send_to_chrome({"ready": True})
                while not closed.is_set():
                    try:
                        connection, _ = server.accept()
                    except socket.timeout:
                        continue
                    with connection:
                        serve(connection, responses, closed)
            finally:
                SOCKET.unlink(missing_ok=True)


def send_local(request):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(TIMEOUT + 3)
        try:
            connection.connect(str(SOCKET))
        except (FileNotFoundError, ConnectionRefusedError) as error:
            raise ValueError("No active session. Click Chrome Agent on a supported tab.") from error
        connection.sendall(encode(request) + b"\n")
        result = receive_line(connection)
    if not result.get("ok"):
        raise ValueError(result.get("error", "Operation failed"))
    print(json.dumps(result["result"], indent=2, ensure_ascii=False))


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    commands = cli.add_subparsers(dest="action", required=True)
    for action in ("install", "uninstall", "inspect"):
        commands.add_parser(action)
    fill = commands.add_parser("fill")
    fill.add_argument("selector")
    fill.add_argument("value")
    file = commands.add_parser("select-file")
    file.add_argument("selector")
    file.add_argument("path", type=lambda value: str(Path(value).expanduser().absolute()))
    if len(sys.argv) == 3 and sys.argv[1] == "--native-host":
        host(sys.argv[2])
        return
    args = cli.parse_args()
    if args.action == "install":
        install()
    elif args.action == "uninstall":
        uninstall()
    else:
        send_local(validated_request(vars(args)))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError) as error:
        print(error, file=sys.stderr)
        sys.exit(1)
