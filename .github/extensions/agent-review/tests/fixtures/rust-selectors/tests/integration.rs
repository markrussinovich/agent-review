mod support;

#[test]
fn integration_root_checks() {
    assert!(selectors::changed());
}
