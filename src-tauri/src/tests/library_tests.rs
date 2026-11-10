use super::*;

#[test]
fn active_library_root_stays_writable_despite_retired_history() {
    // Regression guard: the retired list is append-only history and may
    // name the active root after a move back to a prior location. Writes
    // under the configured root must still be allowed.
    let root = crate::config::configured_library_dir().expect("library dir resolves");
    assert!(ensure_library_write_allowed(&root.join("probe")).is_ok());
}
