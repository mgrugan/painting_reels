#!/usr/bin/env python3
"""
Push rendered reels to Drive and log them in the sheet.

One reel is one "post": a Drive subfolder holding the video, plus a row in the
named tab with the caption and a link to that folder.

Usage:
    python3 push_reel.py <WEBHOOK_URL|-> <TAB> [<N>]

`-` uses REEL_WEBHOOK_URL from pipeline/.env. The shared secret is read from
REEL_WEBHOOK_SECRET there too — never from this file, which is public.

Reels are read from ./outbox — one folder per reel, each holding a video file
and caption.txt:

    outbox/
      the-man-with-his-hand-on-the-valve/
        reel.mp4
        caption.txt

Operational rules this obeys, the hard way:
  * A failed call is NEVER retried. Apps Script frequently runs the request
    server-side even when the response never makes it back, so a retry means a
    duplicate file or a duplicate row. One attempt, 300s timeout, then stop.
  * Every upload and every finished post is recorded to .state/ before the next
    step, and each post's folderUrl is saved the moment it is known. A rerun
    skips what is already done, and a post whose video landed but whose row did
    not gets its row from the saved URL.
  * The separator row goes in once per batch, only when nothing is done yet.
"""

import base64, json, mimetypes, os, subprocess, sys, urllib.error, urllib.request

SECRET = None

HERE = os.path.dirname(os.path.abspath(__file__))
OUTBOX = os.path.join(HERE, 'outbox')
STATE = os.path.join(HERE, '.state')
TIMEOUT = 300
VIDEO_EXTS = ('.mp4', '.webm', '.mov', '.m4v')

# Apps Script takes the whole body in memory, so an 80MB MediaRecorder capture
# is not postable. Transcoding first is also what makes the file uploadable to
# Instagram at all, so it is not a workaround, it is the step that was missing.
MAX_UPLOAD_BYTES = 8 * 1024 * 1024


def state_path(name):
    os.makedirs(STATE, exist_ok=True)
    return os.path.join(STATE, name)


def load_lines(name):
    try:
        with open(state_path(name)) as f:
            return {line.strip() for line in f if line.strip()}
    except FileNotFoundError:
        return set()


def record(name, value):
    with open(state_path(name), 'a') as f:
        f.write(value + '\n')


def load_map(name):
    try:
        with open(state_path(name)) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_map(name, data):
    with open(state_path(name), 'w') as f:
        json.dump(data, f, indent=1)


def call(url, payload):
    """One attempt. Never called twice for the same logical action."""
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        url, data=body, headers={'Content-Type': 'application/json'}, method='POST')
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        raw = r.read().decode()
    try:
        out = json.loads(raw)
    except json.JSONDecodeError:
        raise RuntimeError('non-JSON response (the call may still have run): ' + raw[:300])
    if out.get('error'):
        raise RuntimeError('webhook error: ' + out['error'])
    return out


def ffmpeg():
    for candidate in ('ffmpeg', '/usr/bin/ffmpeg'):
        if subprocess.run(['which', candidate], capture_output=True).returncode == 0:
            return candidate
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        return None


def prepare(video, workdir):
    """
    A constant-frame-rate H.264 MP4 with the index at the front.

    MediaRecorder writes variable frame timing and, on Linux builds without an
    H.264 encoder, VP9. Neither uploads reliably. Re-encoding once here gives a
    file every platform accepts and one small enough to post in a single call.
    """
    exe = ffmpeg()
    out = os.path.join(workdir, 'upload.mp4')
    if not exe:
        print('  ! ffmpeg not found — uploading the original file as-is')
        return video
    for crf in (26, 30, 34):
        subprocess.run(
            [exe, '-hide_banner', '-loglevel', 'error', '-y', '-i', video,
             '-fps_mode', 'cfr', '-r', '30', '-c:v', 'libx264', '-preset', 'veryfast',
             '-crf', str(crf), '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.0',
             '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out],
            check=True)
        size = os.path.getsize(out)
        print(f'  transcoded at crf {crf}: {size / 1e6:.1f} MB')
        if size <= MAX_UPLOAD_BYTES:
            return out
    print('  ! still over the single-call limit; uploading anyway')
    return out


def find_video(folder):
    for name in sorted(os.listdir(folder)):
        if name.lower().endswith(VIDEO_EXTS) and not name.startswith('upload.'):
            return os.path.join(folder, name)
    return None


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    global SECRET
    SECRET, configured_url = load_config()
    url, tab = sys.argv[1], sys.argv[2]
    if url == '-' and configured_url:
        url = configured_url
    limit = int(sys.argv[3]) if len(sys.argv) > 3 else 7

    if not os.path.isdir(OUTBOX):
        sys.exit(f'no outbox at {OUTBOX}')

    posts = sorted(d for d in os.listdir(OUTBOX) if os.path.isdir(os.path.join(OUTBOX, d)))
    done_posts = load_lines('posts.done')
    done_uploads = load_lines('uploads.done')
    folder_urls = load_map('folders.json')

    if not done_posts and not load_lines('separator.done'):
        print('separator row')
        call(url, {'secret': SECRET, 'action': 'addRow', 'tab': tab,
                   'caption': '-----', 'folderUrl': ''})
        record('separator.done', tab)

    todo = [p for p in posts if p not in done_posts][:limit]
    if not todo:
        print(f'nothing left to push ({len(done_posts)} of {len(posts)} done)')
        return

    for post in todo:
        folder = os.path.join(OUTBOX, post)
        print(f'\n{post}')

        video = find_video(folder)
        if not video:
            print('  ! no video file, skipping')
            continue

        caption_file = os.path.join(folder, 'caption.txt')
        if not os.path.exists(caption_file):
            print('  ! no caption.txt, skipping')
            continue
        with open(caption_file, encoding='utf-8') as f:
            caption = f.read().rstrip('\n')

        key = f'{post}/video'
        if key in done_uploads:
            print('  video already uploaded')
        else:
            ready = prepare(video, folder)
            with open(ready, 'rb') as f:
                data = base64.b64encode(f.read()).decode()
            mime = mimetypes.guess_type(ready)[0] or 'video/mp4'
            print(f'  uploading {os.path.basename(ready)} ({len(data) / 1e6:.1f} MB base64)')
            res = call(url, {'secret': SECRET, 'action': 'upload', 'post': post,
                             'filename': f'{post}.mp4', 'mime': mime, 'data': data})
            record('uploads.done', key)
            folder_urls[post] = res['folderUrl']
            save_map('folders.json', folder_urls)

        folder_url = folder_urls.get(post)
        if not folder_url:
            print('  ! no folder URL recorded, cannot add the row')
            continue

        print('  adding row')
        res = call(url, {'secret': SECRET, 'action': 'addRow', 'tab': tab,
                         'caption': caption, 'folderUrl': folder_url})
        record('posts.done', post)
        print(f'  row {res.get("row")}')

    remaining = len([p for p in posts if p not in load_lines('posts.done')])
    print(f'\n{len(posts) - remaining} of {len(posts)} posts done, {remaining} left')


def load_config():
    """
    The shared secret and the webhook URL are credentials, so they live in
    pipeline/.env — which is gitignored — or in the environment. They are
    deliberately not in this file: the repository is public.
    """
    env = os.path.join(HERE, '.env')
    values = dict(os.environ)
    if os.path.exists(env):
        with open(env) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                key, _, value = line.partition('=')
                values.setdefault(key.strip(), value.strip())
    secret = values.get('REEL_WEBHOOK_SECRET')
    if not secret:
        sys.exit(
            'No REEL_WEBHOOK_SECRET. Put it in pipeline/.env as\n'
            '  REEL_WEBHOOK_SECRET=...\n'
            'or export it. It must match SECRET in the Apps Script.')
    return secret, values.get('REEL_WEBHOOK_URL')


if __name__ == '__main__':
    main()
