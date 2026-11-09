"""Source- and revision-matched Rust LCOV ingestion."""
from lcov_coverage import load_snapshot_lcov


def load_rust_coverage(snapshot):
    return load_snapshot_lcov(snapshot, name="rust", language="Rust", extensions=(".rs",))
