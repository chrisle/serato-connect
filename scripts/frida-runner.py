#!/usr/bin/env python3
"""
Run a Frida script attached to a PID, keep the event loop alive, and stream
both console.log and send() output to stdout.

Usage: frida-runner.py <pid> <script.js> [duration_seconds]

Defaults to 60s. Forwards SIGINT to detach cleanly.
"""
import sys
import time
import frida


def main():
    if len(sys.argv) < 3:
        print("Usage: frida-runner.py <pid> <script.js> [duration_seconds]", file=sys.stderr)
        sys.exit(2)

    pid = int(sys.argv[1])
    script_path = sys.argv[2]
    duration = float(sys.argv[3]) if len(sys.argv) > 3 else 60.0

    src = open(script_path).read()
    runtime = sys.argv[4] if len(sys.argv) > 4 else "qjs"
    print(f"[runner] attaching to pid={pid} script={script_path} duration={duration}s runtime={runtime}", flush=True)
    session = frida.attach(pid)
    script = session.create_script(src, runtime=runtime)


    def on_message(message, data):
        if message["type"] == "send":
            print(f"[send] {message['payload']}", flush=True)
        elif message["type"] == "error":
            desc = message.get("description", "?")
            stack = message.get("stack", "?")
            print(f"[error] {desc}\n{stack}", flush=True)
        else:
            # console.log goes through 'log' type per Frida convention
            t = message.get("type", "?")
            payload = message.get("payload", message)
            print(f"[{t}] {payload}", flush=True)

    script.on("message", on_message)
    script.load()
    print("[runner] script loaded, hooks should be active", flush=True)

    end = time.time() + duration
    try:
        while time.time() < end:
            time.sleep(0.5)
    except KeyboardInterrupt:
        print("[runner] SIGINT received, detaching", flush=True)

    print("[runner] unloading script", flush=True)
    try:
        script.unload()
    except Exception as e:
        print(f"[runner] unload err: {e}", flush=True)
    try:
        session.detach()
    except Exception as e:
        print(f"[runner] detach err: {e}", flush=True)
    print("[runner] done", flush=True)


if __name__ == "__main__":
    main()
