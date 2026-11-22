# tierwyn

Global npm launcher for [Tierwyn](https://github.com/tierwyn/tierwyn) — a meta-harness for coding agents.

## Install

```bash
npm install -g tierwyn
```

On first run with no existing install (`~/tierwyn` or `TIERWYN_DIR`), the CLI starts guided `setup`.

## Usage

```bash
tierwyn              # interactive home, or setup on first run
tierwyn setup        # guided install / update
tierwyn doctor       # health checks
tierwyn help         # full command list
```

Requires **Linux** with `bash` and systemd (Node ≥ 22.13).