fn main() {}

mod worker;

#[test]
fn custom_bin_root_checks() {
    assert!(selectors::changed());
}
