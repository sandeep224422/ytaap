---
name: Heroku FFmpeg shared libraries
description: Heroku Apt buildpack's dynamic library path must reach isolated FFmpeg subprocesses.
---

Heroku's Apt buildpack places FFmpeg shared libraries under `.apt`; FFmpeg needs those directories to find libraries such as `libavdevice.so`. Some dependencies, including `libpulsecommon`, live in nested directories such as `usr/lib/x86_64-linux-gnu/pulseaudio`, which are not searched recursively. Deno 2 blocks setting `LD_LIBRARY_PATH` on subprocesses under a fine-grained `--allow-run` permission because loader variables can load injected code.

**Why:** Passing the buildpack's `LD_LIBRARY_PATH` directly caused `NotCapable` in Deno, while clearing the environment made the Apt FFmpeg binary unable to find shared libraries. A Heroku log also showed a dependency under PulseAudio's nested directory remained unresolved when only top-level library paths were supplied.

**How to apply:** Keep the child environment minimal and pass all required direct library directories—including nested Apt dependency directories—as arguments to `/lib64/ld-linux-x86-64.so.2 --library-path ...`; grant `--allow-run` only for that loader path rather than allowing arbitrary subprocesses.
