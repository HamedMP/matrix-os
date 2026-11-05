"""Synthetic Linux qualification only. No files, permission prompts or network."""
import base64
import json
import os
import sys


def main():
    if sys.platform != "linux" or os.getuid() == 0:
        raise RuntimeError("qualification_unavailable")
    import mss
    import mss.tools
    if mss.__version__ != "10.2.0":
        raise RuntimeError("capture_dependency_mismatch")
    with mss.mss(display=":7") as screen:
        monitor = screen.monitors[0]
        if monitor["left"] != 0 or monitor["top"] != 0 or not (1 <= monitor["width"] <= 1600 and 1 <= monitor["height"] <= 1600):
            raise RuntimeError("unsupported_geometry")
        shot = screen.grab(monitor)
        png = mss.tools.to_png(shot.rgb, shot.size)
        if len(png) > 2 * 1024 * 1024:
            raise RuntimeError("image_limit")
        print(json.dumps({"width": shot.width, "height": shot.height, "data": base64.b64encode(png).decode("ascii")}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("capture_unavailable", file=sys.stderr)
        sys.exit(1)
