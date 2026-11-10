use super::*;

#[test]
fn test_is_hidden_path() {
    #[cfg(windows)]
    {
        assert!(!is_hidden_path(".hidden_dotfile", None));
        assert!(!is_hidden_path("normal_file.png", None));
    }
    #[cfg(not(windows))]
    {
        assert!(is_hidden_path(".hidden_dotfile", None));
        assert!(!is_hidden_path("normal_file.png", None));
    }
}
