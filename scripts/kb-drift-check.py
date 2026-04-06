#!/usr/bin/env python3
"""
Knowledge Base Drift Detection

Compares changed files in a git diff against the code-to-KB mapping
(knowledge-base/.kb-map.yml) and warns when KB documents may need updating.

Usage:
    # Compare against main branch (CI mode)
    python3 scripts/kb-drift-check.py --base origin/main

    # Compare last commit (local mode)
    python3 scripts/kb-drift-check.py --base HEAD~1

    # Check specific files
    python3 scripts/kb-drift-check.py --files infra/lib/stacks/bedrock/kb-stack.ts

Exit codes:
    0 — No drift detected, or warnings only
    1 — Script error (missing mapping file, parse error)

Notes:
    - This script emits GitHub Actions annotations (::warning::) when run in CI.
    - It never blocks the build (warn-only mode).
"""

import argparse
import fnmatch
import os
import subprocess
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    # Fallback: parse YAML manually for CI environments without PyYAML
    yaml = None


def parse_kb_map_simple(content: str) -> list[dict]:
    """
    Minimal YAML parser for .kb-map.yml when PyYAML is unavailable.
    Handles the specific structure of our mapping file.
    """
    mappings: list[dict] = []
    current: dict | None = None
    current_key: str | None = None

    for line in content.splitlines():
        stripped = line.strip()

        # Skip comments and empty lines
        if not stripped or stripped.startswith('#'):
            continue

        if stripped == 'mappings:':
            continue

        if stripped.startswith('- name:'):
            if current:
                mappings.append(current)
            current = {
                'name': stripped.split(':', 1)[1].strip().strip('"'),
                'code_paths': [],
                'kb_docs': [],
            }
            current_key = None
            continue

        if stripped == 'code_paths:':
            current_key = 'code_paths'
            continue

        if stripped == 'kb_docs:':
            current_key = 'kb_docs'
            continue

        if stripped.startswith('- "') and current and current_key:
            value = stripped[3:].rstrip('"')
            current[current_key].append(value)
            continue

    if current:
        mappings.append(current)

    return mappings


def load_kb_map(repo_root: Path) -> list[dict]:
    """Load and parse the KB mapping file."""
    map_path = repo_root / 'knowledge-base' / '.kb-map.yml'
    if not map_path.exists():
        print(f'::error::KB mapping file not found: {map_path}')
        sys.exit(1)

    content = map_path.read_text(encoding='utf-8')

    if yaml:
        data = yaml.safe_load(content)
        return data.get('mappings', [])
    else:
        return parse_kb_map_simple(content)


def get_changed_files(base: str, repo_root: Path) -> list[str]:
    """Get list of changed files from git diff."""
    try:
        result = subprocess.run(
            ['git', 'diff', '--name-only', f'{base}...HEAD'],
            cwd=repo_root,
            capture_output=True,
            text=True,
            check=True,
        )
        files = [f.strip() for f in result.stdout.splitlines() if f.strip()]
        if not files:
            # Try without ... syntax (local mode)
            result = subprocess.run(
                ['git', 'diff', '--name-only', base],
                cwd=repo_root,
                capture_output=True,
                text=True,
                check=True,
            )
            files = [f.strip() for f in result.stdout.splitlines() if f.strip()]
        return files
    except subprocess.CalledProcessError as e:
        print(f'::warning::git diff failed: {e.stderr}')
        return []


def match_file_to_patterns(filepath: str, patterns: list[str]) -> bool:
    """Check if a filepath matches any of the glob patterns."""
    for pattern in patterns:
        if fnmatch.fnmatch(filepath, pattern):
            return True
        # Also check if the file is within a directory pattern
        if pattern.endswith('/**') or pattern.endswith('/**/*'):
            dir_pattern = pattern.split('/**')[0]
            if filepath.startswith(dir_pattern + '/'):
                return True
        # Handle ** in the middle of patterns
        if '**' in pattern:
            # Convert glob ** to regex-like matching
            parts = pattern.split('**')
            if len(parts) == 2:
                prefix = parts[0]
                suffix = parts[1].lstrip('/')
                if filepath.startswith(prefix):
                    remaining = filepath[len(prefix):]
                    if not suffix or fnmatch.fnmatch(remaining.split('/')[-1], suffix):
                        return True
    return False


def main() -> None:
    """Main drift detection logic."""
    parser = argparse.ArgumentParser(description='KB drift detection')
    parser.add_argument('--base', default='origin/main', help='Git base ref to compare against')
    parser.add_argument('--files', nargs='*', help='Explicit list of changed files (overrides git diff)')
    parser.add_argument('--repo-root', default='.', help='Repository root directory')
    args = parser.parse_args()

    repo_root = Path(args.repo_root).resolve()
    is_ci = os.environ.get('GITHUB_ACTIONS') == 'true'

    # Load mapping
    mappings = load_kb_map(repo_root)

    # Get changed files
    if args.files:
        changed_files = args.files
    else:
        changed_files = get_changed_files(args.base, repo_root)

    if not changed_files:
        print('No changed files detected. KB is in sync.')
        return

    # Filter out KB files from changed list (they're the target, not the trigger)
    code_changes = [f for f in changed_files if not f.startswith('knowledge-base/')]
    kb_changes = [f for f in changed_files if f.startswith('knowledge-base/')]

    if not code_changes:
        print('Only KB documents changed. No drift detection needed.')
        return

    # Track which KB docs need review
    docs_needing_review: dict[str, list[str]] = {}  # kb_doc -> [reason]
    matched_code_files: set[str] = set()

    for mapping in mappings:
        matching_code = [
            f for f in code_changes
            if match_file_to_patterns(f, mapping.get('code_paths', []))
        ]

        if matching_code:
            matched_code_files.update(matching_code)
            for kb_doc in mapping.get('kb_docs', []):
                kb_full_path = f'knowledge-base/{kb_doc}'
                if kb_full_path not in kb_changes:
                    if kb_doc not in docs_needing_review:
                        docs_needing_review[kb_doc] = []
                    docs_needing_review[kb_doc].append(
                        f'{mapping.get("name", "Unknown")}: {", ".join(matching_code[:3])}'
                    )

    # Report unmapped code changes
    unmapped = [f for f in code_changes if f not in matched_code_files]
    # Filter out common non-documentable files
    unmapped = [
        f for f in unmapped
        if not any(f.endswith(ext) for ext in ['.lock', '.json', '.log'])
        and not f.startswith('.')
        and not f.startswith('node_modules/')
        and not f.startswith('tests/')
    ]

    # Output results
    print('')
    print('=== KB Drift Detection Report ===')
    print(f'  Code files changed:  {len(code_changes)}')
    print(f'  KB files changed:    {len(kb_changes)}')
    print(f'  Mapped code files:   {len(matched_code_files)}')
    print(f'  Unmapped code files: {len(unmapped)}')
    print('')

    if docs_needing_review:
        print(f'⚠️  {len(docs_needing_review)} KB document(s) may need updating:')
        print('')
        for doc, reasons in sorted(docs_needing_review.items()):
            if is_ci:
                print(f'::warning file=knowledge-base/{doc}::KB document may be stale. Code changes in: {reasons[0]}')
            else:
                print(f'  📝 {doc}')
                for reason in reasons:
                    print(f'      ← {reason}')
        print('')
    else:
        print('✅ No KB drift detected — all affected documents were updated.')
        print('')

    if unmapped:
        print(f'📌 {len(unmapped)} code file(s) not covered by any KB mapping:')
        for f in unmapped[:10]:
            if is_ci:
                print(f'::notice file={f}::Code file has no KB mapping in .kb-map.yml')
            else:
                print(f'  • {f}')
        if len(unmapped) > 10:
            print(f'  ... and {len(unmapped) - 10} more')
        print('')

    print('=== End Report ===')


if __name__ == '__main__':
    main()
