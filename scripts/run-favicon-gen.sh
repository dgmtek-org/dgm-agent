#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="${ROOT}/scripts/.venv-favicon"
if [[ ! -x "${VENV}/bin/python3" ]]; then
  python3 -m venv "${VENV}"
  "${VENV}/bin/pip" install -r "${ROOT}/scripts/favicon-gen-requirements.txt"
fi
exec "${VENV}/bin/python3" "${ROOT}/scripts/generate_brand_icons_from_svg.py" --repo-root "${ROOT}" "$@"
