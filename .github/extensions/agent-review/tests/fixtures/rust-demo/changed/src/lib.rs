use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error, PartialEq)]
pub enum ScoreError {
    #[error("value is too small")]
    TooSmall,
}

pub trait Score {
    fn score(&self, value: i32) -> Result<i32, ScoreError>;
}

#[derive(Serialize)]
pub struct Reviewer;

impl Score for Reviewer {
    fn score(&self, value: i32) -> Result<i32, ScoreError> {
        if value < 20 {
            return Err(ScoreError::TooSmall);
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
