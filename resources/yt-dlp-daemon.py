# Persistent yt-dlp worker. Spawned once at app startup; eCoda sends
# newline-delimited JSON requests over stdin and reads newline-delimited
# JSON responses from stdout. Cuts per-resolve Python + extractor init
# (~1.5-2s) out of the hot path — only network time remains.
#
# Protocol:
#   stdin  → {"id": <int>, "cmd": "resolve", "videoId": "...", "browser": "...", "denoPath": "..."}
#   stdout ← {"id": <int>, "ok": true, "title": "...", "ext": "...", "url": "..."}
#          | {"id": <int>, "ok": false, "error": "..."}
#   stdin  → {"id": <int>, "cmd": "ping"}        → {"id": ..., "ok": true}
#   stdin  → {"id": <int>, "cmd": "exit"}        → process exits 0
#
# Argv: sys.argv[1] = absolute path to the yt-dlp zipapp (so we can
#       import yt_dlp from it via zipimport).
#
# Anything yt-dlp prints to its own stdout (no-op normally with
# quiet=True) is captured and dropped; warnings go to stderr where Node
# forwards them to the main log.

import sys
import os
import io
import json
import contextlib
import traceback

if len(sys.argv) < 2:
    sys.stderr.write("usage: yt-dlp-daemon.py <yt-dlp-zipapp-path>\n")
    sys.exit(2)

ZIPAPP_PATH = sys.argv[1]
sys.path.insert(0, ZIPAPP_PATH)

import yt_dlp  # noqa: E402


class _SilentLogger:
    """yt-dlp logger that swallows everything. Forward to stderr only on
    error so Node-side log shows actual failures."""

    def debug(self, msg):
        pass

    def info(self, msg):
        pass

    def warning(self, msg):
        pass

    def error(self, msg):
        sys.stderr.write(f"[yt-dlp] {msg}\n")


_BASE_OPTS = {
    "format": "bestaudio",
    "noplaylist": True,
    "quiet": True,
    "no_warnings": True,
    "logger": _SilentLogger(),
    # YT Music client first, plain web as fallback — matches resolveAudio
    # in ytdlp.ts. Some Premium / region-fenced tracks come back "Video
    # unavailable" under the default web client but resolve cleanly via
    # web_music.
    "extractor_args": {"youtube": {"player_client": ["web_music", "web"]}},
}

# YoutubeDL instances are expensive to construct (loading 1864 extractors,
# spinning up the requests session, parsing cookies). Cache one per
# (browser, denoPath) combination so subsequent resolves reuse it.
_ydl_cache: dict = {}


def _get_ydl(browser: str | None, deno_path: str | None) -> yt_dlp.YoutubeDL:
    key = (browser, deno_path)
    if key in _ydl_cache:
        return _ydl_cache[key]
    opts = dict(_BASE_OPTS)
    if browser:
        # cookiesfrombrowser is a tuple: (BROWSER, PROFILE, KEYRING, CONTAINER)
        opts["cookiesfrombrowser"] = (browser,)
    if deno_path:
        # Same shape the CLI builds from `--js-runtimes deno:<path>` —
        # see yt_dlp/__init__.py "js_runtimes = {...}" parsing.
        opts["js_runtimes"] = {"deno": {"path": deno_path}}
    ydl = yt_dlp.YoutubeDL(opts)
    _ydl_cache[key] = ydl
    return ydl


def _resolve(payload: dict) -> dict:
    video_id = payload["videoId"]
    browser = payload.get("browser")
    deno_path = payload.get("denoPath")
    ydl = _get_ydl(browser, deno_path)
    url = f"https://music.youtube.com/watch?v={video_id}"
    # extract_info with download=False returns the info dict for the
    # selected format (because we set format='bestaudio'). info['url']
    # is the playable stream URL with n-sig solved.
    sink = io.StringIO()
    with contextlib.redirect_stdout(sink):
        info = ydl.extract_info(url, download=False)
    if not info:
        raise RuntimeError("yt-dlp returned no info")
    stream_url = info.get("url")
    if not stream_url:
        # Selected format didn't carry a direct URL (rare — usually means
        # YT forced SABR streaming and yt-dlp could not solve it).
        raise RuntimeError("no stream URL in selected format")
    return {
        "title": info.get("title") or "",
        "ext": info.get("ext") or "",
        "url": stream_url,
    }


def _write(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=True))
    sys.stdout.write("\n")
    sys.stdout.flush()


def main() -> int:
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        req_id = None
        try:
            req = json.loads(raw)
            req_id = req.get("id")
            cmd = req.get("cmd")
            if cmd == "resolve":
                result = _resolve(req)
                _write({"id": req_id, "ok": True, **result})
            elif cmd == "ping":
                _write({"id": req_id, "ok": True})
            elif cmd == "exit":
                _write({"id": req_id, "ok": True})
                return 0
            else:
                _write({"id": req_id, "ok": False, "error": f"unknown cmd {cmd}"})
        except Exception as err:  # noqa: BLE001
            sys.stderr.write(f"[yt-dlp-daemon] error: {traceback.format_exc()}")
            _write({"id": req_id, "ok": False, "error": str(err)})
    return 0


if __name__ == "__main__":
    sys.exit(main())
