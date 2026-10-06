"""Pytest plugin that records which lines of the reviewed files each test executes.

Loaded with ``-p agent_review_trace`` only for an explicit "Run linked tests"
request. Tracing is restricted to the files named in AGENT_REVIEW_TRACE_FILES;
all other frames are skipped. Results are written as JSON to
AGENT_REVIEW_TRACE_OUTPUT when the session finishes.
"""
from __future__ import annotations

import json
import os
import sys
import threading
import time

import pytest

_TARGETS = {os.path.normcase(os.path.abspath(path)) for path in json.loads(os.environ.get("AGENT_REVIEW_TRACE_FILES", "[]"))}
_OUTPUT = os.environ.get("AGENT_REVIEW_TRACE_OUTPUT")
_matches: dict = {}
_lines = None
_results: dict = {}


def _target(filename):
    if filename not in _matches:
        normalized = os.path.normcase(os.path.abspath(filename))
        _matches[filename] = normalized if normalized in _TARGETS else None
    return _matches[filename]


def _local(frame, event, arg):
    if event == "line" and _lines is not None:
        _lines.add((frame.f_code.co_filename, frame.f_lineno))
    return _local


def _global(frame, event, arg):
    if _lines is None or not _target(frame.f_code.co_filename):
        return None
    return _local


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_protocol(item, nextitem):
    global _lines
    _lines = set()
    started = time.perf_counter()
    previous = sys.gettrace()
    threading.settrace(_global)
    sys.settrace(_global)
    try:
        yield
    finally:
        sys.settrace(previous)
        threading.settrace(None)
        record = _results.setdefault(item.nodeid, {"outcome": "passed"})
        record["duration_ms"] = round((time.perf_counter() - started) * 1000)
        lines = {}
        for filename, line in _lines:
            lines.setdefault(_target(filename), []).append(line)
        record["lines"] = {path: sorted(set(values)) for path, values in lines.items()}
        _lines = None


def pytest_runtest_logreport(report):
    record = _results.setdefault(report.nodeid, {"outcome": "passed"})
    if report.failed:
        record["outcome"] = "failed" if report.when == "call" else "error"
    elif report.skipped and record["outcome"] == "passed":
        record["outcome"] = "skipped"


def pytest_sessionfinish(session, exitstatus):
    if not _OUTPUT:
        return
    with open(_OUTPUT, "w", encoding="utf-8") as handle:
        json.dump({"tests": _results, "exit_status": int(exitstatus), "python": sys.version.split()[0]}, handle)
