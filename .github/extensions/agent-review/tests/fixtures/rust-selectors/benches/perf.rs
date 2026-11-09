fn main() {}

#[test]
fn bench_checks() {
    assert!(selectors::changed());
}
