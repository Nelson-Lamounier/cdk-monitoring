"""Local conftest for workloads/charts/public-api/tests/.

Inserts the chart directory into sys.path so ``from deploy import ...``
resolves to public-api/deploy.py.

This is required because multiple workload charts share the module name
``deploy`` (public-api, nextjs, admin-api, start-admin). Adding the chart
directory to pyproject.toml's global pythonpath would cause resolution
ambiguity. The conftest keeps the path insertion scoped to this directory.
"""
from __future__ import annotations

import sys
from pathlib import Path

_CHART_DIR = Path(__file__).resolve().parent.parent  # workloads/charts/public-api

if str(_CHART_DIR) not in sys.path:
    sys.path.insert(0, str(_CHART_DIR))
