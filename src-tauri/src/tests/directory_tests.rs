use super::*;

#[test]
fn library_nodes_are_single_galleries_without_nested_tree() {
    let root = std::env::temp_dir().join(format!(
        "quivit_library_nodes_{}_{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let series = root.join("Series");
    fs::create_dir_all(&series).unwrap();
    fs::write(
        series.join("gallery.json"),
        r#"{"title":"Series Title","images":[{"filename":"Cover.jpg"}]}"#,
    )
    .unwrap();

    let nodes = read_library_nodes(&root);
    assert_eq!(nodes.len(), 1);
    assert_eq!(nodes[0].name, "Series");
    assert_eq!(nodes[0].title.as_deref(), Some("Series Title"));
    assert!(nodes[0].is_gallery);
    assert_eq!(nodes[0].image_count, 1);

    let _ = fs::remove_dir_all(root);
}

#[test]
fn library_nodes_never_include_files_under_subdirectories() {
    let root = std::env::temp_dir().join(format!(
        "quivit_library_files_{}_{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let provider = root.join("Imgur");
    let album = provider.join("My Album");
    fs::create_dir_all(&album).unwrap();

    // Direct raw file under provider root
    fs::write(provider.join("direct.png"), "image").unwrap();

    // Files inside album
    fs::write(album.join("001.png"), "placeholder").unwrap();
    fs::write(album.join("002.png"), "placeholder").unwrap();

    // Without gallery.json: album is not a recognized gallery, so it's skipped
    let nodes = read_library_nodes(&provider);
    assert_eq!(nodes.len(), 1);
    assert_eq!(nodes[0].name, "direct.png");
    assert!(!nodes[0].is_dir);

    // With gallery.json: album is recognized as a gallery with image_count = 2
    fs::write(
        album.join("gallery.json"),
        r#"{"title":"My Album","images":[{"filename":"001.png"},{"filename":"002.png"}]}"#,
    )
    .unwrap();

    let nodes_with_gallery = read_library_nodes(&provider);
    assert_eq!(nodes_with_gallery.len(), 2);
    let gallery_node = nodes_with_gallery.iter().find(|n| n.name == "My Album").unwrap();
    assert!(gallery_node.is_dir);
    assert!(gallery_node.is_gallery);
    assert_eq!(gallery_node.image_count, 2);

    let _ = fs::remove_dir_all(root);
}

#[test]
fn test_create_placeholder_files() {
    let temp_dir =
        std::env::temp_dir().join(format!("quivit_test_placeholders_{}", std::process::id()));
    let filenames = vec!["001.png".to_string(), "002.png".to_string()];
    let res = create_placeholder_files(temp_dir.to_string_lossy().into_owned(), filenames);
    assert!(res.is_ok());

    assert!(temp_dir.join("001.png").is_file());
    assert!(temp_dir.join("002.png").is_file());
    assert_eq!(temp_dir.join("001.png").metadata().unwrap().len(), 0);

    let _ = fs::remove_dir_all(temp_dir);
}

#[test]
fn test_remove_file() {
    let temp_file =
        std::env::temp_dir().join(format!("quivit_test_remove_{}", std::process::id()));
    fs::write(&temp_file, "hello").unwrap();
    assert!(temp_file.is_file());

    let res = remove_file(temp_file.to_string_lossy().into_owned());
    assert!(res.is_ok());
    assert!(!temp_file.exists());

    // Deleting non-existent file should succeed as a no-op
    let res2 = remove_file(temp_file.to_string_lossy().into_owned());
    assert!(res2.is_ok());
}

#[test]
fn test_remove_directory_safety() {
    let non_existent =
        std::env::temp_dir().join(format!("quivit_non_existent_{}", std::process::id()));
    let res = tauri::async_runtime::block_on(remove_directory(
        non_existent.to_string_lossy().into_owned(),
    ));
    assert!(res.is_ok());

    let outside_dir = std::env::temp_dir();
    let res_outside = tauri::async_runtime::block_on(remove_directory(
        outside_dir.to_string_lossy().into_owned(),
    ));
    assert!(res_outside.is_err());
}
