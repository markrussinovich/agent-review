pub fn changed() -> bool {
    true
}

#[test]
fn root_checks() {
    assert!(changed());
}

mod app;
mod folder;

mod inline {
    mod leaf;
}

#[path = "../custom/renamed.rs"]
mod r#match;

#[path = "redirected"]
mod relocated {
    #[path = "leaf.rs"]
    mod nested;
}
