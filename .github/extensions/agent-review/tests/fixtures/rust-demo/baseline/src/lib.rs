use serde::Serialize;

pub trait Score {
    fn score(&self, value: i32) -> Result<i32, &'static str>;
}

#[derive(Serialize)]
pub struct Reviewer;

impl Score for Reviewer {
    fn score(&self, value: i32) -> Result<i32, &'static str> {
        if value < 10 {
            return Err("small");
        }
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_large_values() {
        assert_eq!(Reviewer.score(20), Ok(20));
    }
}
