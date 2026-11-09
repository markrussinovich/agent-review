mod tests {
    #[test]
    fn nonroot_checks() {
        assert!(crate::changed());
    }
}

mod nested;

mod inline {
    #[path = "alias.rs"]
    mod mapped;
}

#[path = "../custom/sibling.rs"]
mod sibling;

#[path = "app_redirected"]
mod relocated {
    #[path = "leaf.rs"]
    mod child;
}
