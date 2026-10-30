#!/usr/bin/env python3
"""Checks the Grafana dashboards shipped with the Helm chart (make chart-lint).

For every deploy/charts/vault-sync/dashboards/*.json:

  - it parses as JSON and has a UID starting with "vault-sync-", unique
    across the dashboards;
  - it has a Prometheus datasource variable "datasource" and query
    variables "namespace" and "job", and every panel and query variable
    uses ${datasource};
  - every metric a query or variable references is documented in the
    generated docs/admin/metrics-reference.md (a histogram's _bucket,
    _sum and _count series count as the histogram; go_* and process_* as
    documented there), so renaming a metric breaks
    the build;
  - every query of a service-wide metric (vault_sync_service_*) takes the
    max over replicas and never sums them, since every replica serves the
    same values.

Usage: dashboard_test.py [DASHBOARD_DIR [METRICS_REFERENCE_MD]]
"""

import json
import pathlib
import re
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent
DATASOURCE_UID = "${datasource}"
KEYWORDS = {"by", "without", "on", "ignoring", "group_left", "group_right", "and", "or", "unless", "bool", "offset", "inf", "nan"}
HISTOGRAM_SUFFIXES = ("_bucket", "_sum", "_count")


def documented_metrics(reference):
    """Returns (names, histograms, prefixes) from the metrics tables."""
    text = reference.read_text()
    names, histograms, prefixes = set(), set(), set()
    section = None
    for line in text.splitlines():
        if line.startswith("## "):
            section = line[3:].strip()
            continue
        if section not in ("Per-replica metrics", "Service-wide metrics"):
            continue
        row = re.match(r"^\| `([a-z_:][a-z0-9_:]*)` \| (\w+) \|", line)
        if row:
            names.add(row.group(1))
            if row.group(2) == "histogram":
                histograms.add(row.group(1))
        prefixes.update(re.findall(r"`([a-z]+_)\*`", line))
    return names, histograms, prefixes


def referenced_metrics(expr):
    """Returns the metric names a PromQL expression or label_values() query references."""
    metrics = set(re.findall(r"label_values\(\s*([a-zA-Z_:][a-zA-Z0-9_:]*)", expr))
    expr = re.sub(r'"(?:[^"\\]|\\.)*"', " ", expr)
    expr = re.sub(r"\{[^}]*\}", " ", expr)
    expr = re.sub(r"label_values\(\s*[^,)]*,\s*[a-zA-Z_]+\s*\)", " ", expr)
    expr = re.sub(r"\[[^\]]*\]", " ", expr)
    expr = re.sub(r"\b(by|without|on|ignoring|group_left|group_right)\s*\([^)]*\)", " ", expr)
    for match in re.finditer(r"(?<![\w$.])([a-zA-Z_:][a-zA-Z0-9_:]*)\b(?!\s*\()", expr):
        name = match.group(1)
        if name.lower() not in KEYWORDS:
            metrics.add(name)
    return metrics


def is_documented(name, names, histograms, prefixes):
    if name in names or any(name.startswith(prefix) for prefix in prefixes):
        return True
    return any(name.endswith(suffix) and name[: -len(suffix)] in histograms for suffix in HISTOGRAM_SUFFIXES)


def panels(items):
    for panel in items:
        yield panel
        yield from panels(panel.get("panels", []))


def check_dashboard(path, documented, uids, errors):
    def fail(message):
        errors.append(f"{path.name}: {message}")

    try:
        dashboard = json.loads(path.read_text())
    except json.JSONDecodeError as error:
        fail(f"does not parse: {error}")
        return
    uid = dashboard.get("uid", "")
    if not uid.startswith("vault-sync-"):
        fail(f'UID {uid!r} does not start with "vault-sync-"')
    if uid in uids:
        fail(f"UID {uid!r} is also used by {uids[uid]}")
    uids[uid] = path.name

    variables = {variable.get("name"): variable for variable in dashboard.get("templating", {}).get("list", [])}
    datasource = variables.get("datasource", {})
    if datasource.get("type") != "datasource" or datasource.get("query") != "prometheus":
        fail('has no Prometheus datasource variable "datasource"')
    for name in ("namespace", "job"):
        if variables.get(name, {}).get("type") != "query":
            fail(f'has no query variable "{name}"')

    queries = []
    for name, variable in variables.items():
        if variable.get("type") != "query":
            continue
        if variable.get("datasource", {}).get("uid") != DATASOURCE_UID:
            fail(f'variable "{name}" does not use {DATASOURCE_UID}')
        query = variable.get("query")
        queries.append((f'variable "{name}"', query.get("query", "") if isinstance(query, dict) else query or ""))
    for panel in panels(dashboard.get("panels", [])):
        if panel.get("type") == "row":
            continue
        title = f'panel "{panel.get("title")}"'
        if panel.get("datasource", {}).get("uid") != DATASOURCE_UID:
            fail(f"{title} does not use {DATASOURCE_UID}")
        if not panel.get("targets"):
            fail(f"{title} has no query")
        for target in panel.get("targets", []):
            if target.get("datasource", {}).get("uid") != DATASOURCE_UID:
                fail(f"{title} has a query that does not use {DATASOURCE_UID}")
            queries.append((title, target.get("expr", "")))

    for where, expr in queries:
        metrics = referenced_metrics(expr)
        if not metrics:
            fail(f"{where} references no metric: {expr}")
        for metric in sorted(metrics):
            if not is_documented(metric, *documented):
                fail(f"{where} references {metric}, which docs/admin/metrics-reference.md does not document")
        if any(metric.startswith("vault_sync_service_") for metric in metrics) and not where.startswith("variable"):
            if re.search(r"\b(sum|count|avg)\b", expr) or not re.search(r"\bmax\b", expr):
                fail(f"{where} must take the max of a service-wide metric over replicas, never sum it: {expr}")


def main(argv):
    directory = pathlib.Path(argv[1]) if len(argv) > 1 else REPO / "deploy/charts/vault-sync/dashboards"
    reference = pathlib.Path(argv[2]) if len(argv) > 2 else REPO / "docs/admin/metrics-reference.md"
    documented = documented_metrics(reference)
    if not documented[0]:
        print(f"dashboard_test: found no metrics in {reference}", file=sys.stderr)
        return 1
    files = sorted(directory.glob("*.json"))
    if not files:
        print(f"dashboard_test: found no dashboards in {directory}", file=sys.stderr)
        return 1
    errors, uids = [], {}
    for path in files:
        check_dashboard(path, documented, uids, errors)
    for error in errors:
        print(f"FAIL - {error}", file=sys.stderr)
    if errors:
        print(f"dashboard_test: {len(errors)} check(s) failed", file=sys.stderr)
        return 1
    print(f"ok   - {len(files)} dashboards parse, use ${{datasource}}, namespace and job, have unique UIDs and reference only documented metrics")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
