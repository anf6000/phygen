"""Build the phygen documentation video.

The sources are 4K timelapses at one frame per second. The script renders title
cards with the project palette, normalizes every chapter to 1920x1080 at 30 fps,
resamples each run so its whole arc fits a few minutes, and then joins the parts
with OpenMontage's VideoTrimmer (ffmpeg concat). A silent stereo track is added
last, so a person can narrate over the cut.

Run from anywhere:  py -3 docs/site/video/make_video.py
"""
from __future__ import annotations

import math
import random
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
DOCS = HERE.parent.parent                     # docs/
ROOT = DOCS.parent                            # repo root
OUT = HERE / "phygen-documentation.mp4"
WORK = HERE / ".work"
VIDEOS = DOCS / "videos"
RECORDINGS = DOCS / "recordings"
OPENMONTAGE = Path(r"S:\PROJECTS\OpenMontage")

W, H, FPS = 1920, 1080, 30
INK, BG, ACCENT, MUTED, QUIET = "#000000", "#ffffff", "#0000ff", "#767676", "#f2f2f2"

FONT = r"C:\Windows\Fonts\DejaVuSansMono.ttf"
FONT_B = r"C:\Windows\Fonts\DejaVuSansMono.ttf"


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(FONT_B if bold else FONT, size)


def network(draw: ImageDraw.ImageDraw, cx: int, cy: int, radius: int, seeds: int, color: str) -> None:
    """A small deterministic physarum-like branching network."""
    rng = random.Random(1337)
    for _ in range(seeds):
        angle = rng.random() * math.tau
        x, y = float(cx), float(cy)
        for _ in range(rng.randint(60, 260)):
            angle += (rng.random() - 0.5) * 0.5
            x += math.cos(angle)
            y += math.sin(angle)
            if math.hypot(x - cx, y - cy) > radius:
                break
            draw.point((int(x), int(y)), fill=color)


def card(path: Path, kind: str, title: str, sub: str, meta: str) -> None:
    """Render one 1920x1080 title card."""
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)

    # top bar, like the app header
    d.rectangle([0, 0, W, 70], fill=INK)
    d.text((36, 22), "phygen", font=font(30, True), fill=BG)
    d.text((190, 28), "documentation", font=font(24), fill="#bbbbbb")
    d.text((W - 300, 28), "4:30 cut · narrate over", font=font(20), fill="#bbbbbb")

    if kind == "title":
        d.rectangle([0, 90, W, 96], fill=ACCENT)
        d.text((36, 170), title, font=font(120, True), fill=INK)
        d.text((40, 330), sub, font=font(40), fill=MUTED)
        d.text((40, 420), meta, font=font(28), fill=MUTED)
        network(d, W - 420, 640, 300, 900, INK)
        network(d, W - 420, 640, 150, 500, ACCENT)
        # palette swatch
        x = 40
        for name, col in (("bg", BG), ("ink", INK), ("accent", ACCENT), ("muted", MUTED), ("quiet", QUIET)):
            d.rectangle([x, 520, x + 90, 610], fill=col, outline=INK)
            d.text((x, 620), name, font=font(20), fill=INK)
            x += 110
    elif kind == "chapter":
        d.rectangle([0, 90, W, 96], fill=ACCENT)
        d.text((36, 150), sub, font=font(26), fill=MUTED)          # the number
        d.text((36, 230), title, font=font(72, True), fill=INK)
        d.text((40, 340), meta, font=font(30), fill=MUTED)
        d.rectangle([40, 420, 260, 424], fill=ACCENT)
    else:  # close
        d.rectangle([0, 90, W, 96], fill=ACCENT)
        d.text((36, 180), title, font=font(72, True), fill=INK)
        d.text((40, 300), sub, font=font(30), fill=MUTED)
        d.text((40, 360), meta, font=font(26), fill=MUTED)
        x = 40
        for line in ("runtime/ · threejs/ · server/ · web/", "docs/site/index.html", "docs/API.md · docs/ARCHITECTURE.md"):
            d.text((40, 460 + (x - 40) // 1), line, font=font(28), fill=INK)
            x += 46

    im.save(path)


def run(cmd: list[str]) -> None:
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.stderr.write("\n".join(cmd) + "\n" + proc.stderr[-3000:])
        raise SystemExit(f"command failed: {cmd[0]}")


def encode_card(card_png: Path, seconds: int, out: Path) -> None:
    run(["ffmpeg", "-y", "-v", "error", "-loop", "1", "-t", str(seconds), "-i", str(card_png),
         "-vf", f"scale={W}:{H},fps={FPS}",
         "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
         "-g", str(FPS), "-keyint_min", str(FPS), "-sc_threshold", "0", "-an", str(out)])


NORM = (f"scale={W}:{H}:force_original_aspect_ratio=decrease,"
        f"pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color=black,fps={FPS}")


def encode_clip(src: Path, keep: int, out: Path, from_frames: bool) -> None:
    if from_frames:
        inp = ["-start_number", "0", "-framerate", "1", "-i", str(src / "frame-%05d.png")]
    else:
        inp = ["-i", str(src)]
    chain = f"select='not(mod(n\\,{keep}))',setpts=N/{FPS}/TB,{NORM}"
    run(["ffmpeg", "-y", "-v", "error", *inp, "-vf", chain,
         "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
         "-g", str(FPS), "-keyint_min", str(FPS), "-sc_threshold", "0", "-an", str(out)])


def main() -> None:
    if WORK.exists():
        shutil.rmtree(WORK)
    WORK.mkdir(parents=True)
    parts: list[Path] = []

    # title
    c = WORK / "c00.png"
    card(c, "title", "phygen", "evolve a generative artwork through agent sessions",
         "a 4½-minute cut from the project's own screencasts · narrate over it · no voice track")
    p = WORK / "p00.mp4"; encode_card(c, 5, p); parts.append(p)

    chapters = [
        ("1", "The long documented run", "2026-09-16 · the tree interface, captured at 2160p",
         VIDEOS / "2026-09-16_17-43-33_run_mu4e3as96e69916b.mp4", 3, False),
        ("2", "A second run", "2026-09-17 · the judged tree, three variants per evolution",
         VIDEOS / "2026-09-17_05-33-44_run_mu53glkw75b77d9a.mp4", 2, False),
        ("3", "The morning run", "2026-09-18 · following the work without moving the zoom",
         VIDEOS / "2026-09-18_07-34-08_run_mu6n7aed9d802d57.mp4", 2, False),
        ("4", "The midday run", "2026-09-18 · the agent feed and the decision",
         VIDEOS / "2026-09-18_13-14-58_run_mu6zdln429cfd73a.mp4", 1, False),
        ("5", "The afternoon run", "2026-09-18 · the live artwork and the frames panel",
         VIDEOS / "2026-09-18_13-53-29_run_mu70r4x5bb894585.mp4", 1, False),
        ("6", "The late run", "recovered from the PNG frame dump of the final recording",
         RECORDINGS / "2026-09-18_15-21-47_run_mu73worvf803cf34", 1, True),
    ]

    for i, (num, title, meta, src, keep, from_frames) in enumerate(chapters, start=1):
        c = WORK / f"c{i:02d}.png"
        card(c, "chapter", title, f"chapter {num}", meta)
        p = WORK / f"p{i:02d}.mp4"; encode_card(c, 3, p); parts.append(p)
        clip = WORK / f"k{i:02d}.mp4"
        encode_clip(src, keep, clip, from_frames)
        parts.append(clip)
        print(f"chapter {num}: {title}", flush=True)

    c = WORK / "c99.png"
    card(c, "close", "one child per step", "always kept · a person judges the frames",
         "the chain is the record · the frames are the evidence")
    p = WORK / "p99.mp4"; encode_card(c, 5, p); parts.append(p)

    # join with OpenMontage's VideoTrimmer
    sys.path.insert(0, str(OPENMONTAGE))
    from tools.video.video_trimmer import VideoTrimmer  # noqa: E402

    silent = WORK / "joined.mp4"
    result = VideoTrimmer().execute({
        "operation": "concat",
        "segments": [{"input_path": str(p)} for p in parts],
        "output_path": str(silent),
    })
    if not getattr(result, "success", False):
        raise SystemExit(f"VideoTrimmer concat failed: {result}")
    print("concat done via OpenMontage VideoTrimmer", flush=True)

    # add a silent stereo bed so a narrator has a track
    run(["ffmpeg", "-y", "-v", "error", "-i", str(silent),
         "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
         "-c:v", "copy", "-c:a", "aac", "-b:a", "96k", "-shortest", "-movflags", "+faststart",
         str(OUT)])

    dur = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                          "-of", "default=nw=1:nk=1", str(OUT)], capture_output=True, text=True)
    print(f"wrote {OUT}  ({float(dur.stdout):.1f}s)")

    shutil.rmtree(WORK, ignore_errors=True)


if __name__ == "__main__":
    main()
