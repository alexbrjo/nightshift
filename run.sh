#!/bin/bash
cd /Users/Shared/sv-alex/repositories/nightshift
source venv/bin/activate
python -m uvicorn src.backend.main:app --host 127.0.0.1 --port 8000
