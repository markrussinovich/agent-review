fn main() {}

// Running a selector without pinning the library would also run this failing test.
#[test]
fn root_checks() {
    panic!("wrong Cargo target");
}
