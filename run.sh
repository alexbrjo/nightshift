#!/bin/bash
export PATH="$HOME/.pyenv/bin:$PATH"
eval "$(pyenv init -)"
PYENV_VERSION=3.10.15 python -m uvicorn src.backend.main:app --host 127.0.0.1 --port 8000
