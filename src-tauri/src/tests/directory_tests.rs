use super::*;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

struct TempDirGuard {
    path: PathBuf,
}

impl TempDirGuard {
    fn new(prefix: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("{}_{}_{}", prefix, std::process::id(), nanos));
        fs::create_dir_all(&path).unwrap();
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn to_str(&self) -> String {
        self.path.to_string_lossy().into_owned()
    }
}

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[test]
fn library_nodes_are_single_galleries_without_nested_tree() {
    let temp = TempDirGuard::new("quivit_library_nodes");
    let series = temp.path().join("Series");
    fs::create_dir_all(&series).unwrap();
    fs::write(
        series.join("gallery.json"),
        r#"{"title":"Series Title","images":[{"filename":"Cover.jpg"}]}"#,
    )
    .unwrap();

    let nodes = read_library_nodes(temp.path());
    assert_eq!(nodes.len(), 1);
    assert_eq!(nodes[0].name, "Series");
    assert_eq!(nodes[0].title.as_deref(), Some("Series Title"));
    assert!(nodes[0].is_gallery);
    assert_eq!(nodes[0].image_count, 1);
}

#[test]
fn library_nodes_never_include_files_under_subdirectories() {
    let temp = TempDirGuard::new("quivit_library_files");
    let provider = temp.path().join("Imgur");
    let album = provider.join("My Album");
    fs::create_dir_all(&album).unwrap();

    fs::write(provider.join("direct.png"), "image").unwrap();
    fs::write(album.join("001.png"), "placeholder").unwrap();
    fs::write(album.join("002.png"), "placeholder").unwrap();

    let nodes = read_library_nodes(&provider);
    assert_eq!(nodes.len(), 1);
    assert_eq!(nodes[0].name, "direct.png");
    assert!(!nodes[0].is_dir);

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
}

#[test]
fn test_create_placeholder_files() {
    let temp = TempDirGuard::new("quivit_test_placeholders");
    let filenames = vec!["001.png".to_string(), "002.png".to_string()];
    let res = create_placeholder_files(temp.to_str(), filenames);
    assert!(res.is_ok());

    assert!(temp.path().join("001.png").is_file());
    assert!(temp.path().join("002.png").is_file());
    assert_eq!(temp.path().join("001.png").metadata().unwrap().len(), 0);
}

#[test]
fn test_remove_file() {
    let temp = TempDirGuard::new("quivit_test_remove");
    let file = temp.path().join("hello.txt");
    fs::write(&file, "hello").unwrap();
    assert!(file.is_file());

    let res = remove_file(file.to_string_lossy().into_owned());
    assert!(res.is_ok());
    assert!(!file.exists());

    let res2 = remove_file(file.to_string_lossy().into_owned());
    assert!(res2.is_ok());
}

#[test]
fn test_read_directory_impl_populated_and_sorting() {
    let temp = TempDirGuard::new("quivit_read_dir_pop");
    let root = temp.path();

    let sub_10 = root.join("dir_10");
    let sub_2 = root.join("dir_2");
    let sub_a = root.join("alpha_dir");
    fs::create_dir_all(&sub_10).unwrap();
    fs::create_dir_all(&sub_2).unwrap();
    fs::create_dir_all(&sub_a).unwrap();

    fs::write(root.join("10.jpg"), b"data10").unwrap();
    fs::write(root.join("2.jpg"), b"data2").unwrap();
    fs::write(root.join("cover.PNG"), b"pngdata").unwrap();
    fs::write(root.join("photo.webp"), b"webpdata").unwrap();

    fs::write(root.join("archive.zip"), b"zipdata").unwrap();
    fs::write(root.join("bundle.cbz"), b"cbzdata").unwrap();

    fs::write(root.join("notes.txt"), b"text").unwrap();
    fs::write(root.join("script.py"), b"print(1)").unwrap();
    fs::write(root.join("binary.bin"), b"\x00\x01").unwrap();

    let res = read_directory_impl(&temp.to_str(), false, None).expect("read_directory_impl succeeds");

    assert_eq!(res.directory, temp.to_str());
    assert_eq!(
        res.parent_directory,
        Some(root.parent().unwrap().to_string_lossy().into_owned())
    );

    for file in &res.files {
        assert_ne!(file.name, "notes.txt");
        assert_ne!(file.name, "script.py");
        assert_ne!(file.name, "binary.bin");
    }

    let first_file_idx = res.files.iter().position(|f| !f.is_dir);
    if let Some(idx) = first_file_idx {
        for entry in &res.files[..idx] {
            assert!(entry.is_dir, "entry before first file must be a directory");
        }
        for entry in &res.files[idx..] {
            assert!(!entry.is_dir, "entry after first file must be a file");
        }
    }

    let dir_names: Vec<&str> = res
        .files
        .iter()
        .filter(|f| f.is_dir)
        .map(|f| f.name.as_str())
        .collect();
    assert_eq!(dir_names, vec!["alpha_dir", "dir_2", "dir_10"]);

    let file_names: Vec<&str> = res
        .files
        .iter()
        .filter(|f| !f.is_dir)
        .map(|f| f.name.as_str())
        .collect();

    let pos_2 = file_names.iter().position(|&n| n == "2.jpg").unwrap();
    let pos_10 = file_names.iter().position(|&n| n == "10.jpg").unwrap();
    assert!(pos_2 < pos_10, "natural sorting must place 2.jpg before 10.jpg");

    let png_entry = res
        .files
        .iter()
        .find(|f| f.name == "cover.PNG")
        .expect("cover.PNG should be included");
    assert_eq!(png_entry.ext, "PNG");
    assert_eq!(png_entry.size, 7);
}

#[test]
fn test_read_directory_impl_target_and_file_path() {
    let temp = TempDirGuard::new("quivit_read_dir_target");
    let root = temp.path();

    fs::write(root.join("2.jpg"), b"data2").unwrap();
    fs::write(root.join("10.jpg"), b"data10").unwrap();

    let res_override = read_directory_impl(&temp.to_str(), false, Some("10.jpg")).unwrap();
    assert_eq!(res_override.target_filename, "10.jpg");
    assert_eq!(res_override.files[res_override.initial_index].name, "10.jpg");

    let file_path = root.join("2.jpg").to_string_lossy().into_owned();
    let res_file = read_directory_impl(&file_path, false, None).unwrap();
    assert_eq!(res_file.directory, temp.to_str());
    assert_eq!(res_file.target_filename, "2.jpg");
    assert_eq!(res_file.files[res_file.initial_index].name, "2.jpg");

    let res_cmd = read_directory(temp.to_str(), Some(false), Some("10.jpg".into())).unwrap();
    assert_eq!(res_cmd.target_filename, "10.jpg");
    assert_eq!(res_cmd.files[res_cmd.initial_index].name, "10.jpg");
}

#[test]
fn test_read_directory_impl_errors() {
    let non_existent = std::env::temp_dir().join(format!(
        "quivit_missing_{}_{}",
        std::process::id(),
        SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    ));

    let res = read_directory_impl(&non_existent.to_string_lossy(), false, None);
    assert_eq!(res.unwrap_err(), "Path does not exist");

    let res_empty = read_directory_impl("", false, None);
    assert_eq!(res_empty.unwrap_err(), "Path does not exist");
}

#[test]
fn test_get_path_kind() {
    let temp = TempDirGuard::new("quivit_path_kind");
    let file = temp.path().join("probe.txt");
    fs::write(&file, "kind").unwrap();

    assert_eq!(get_path_kind(&temp.to_str()), "directory");
    assert_eq!(get_path_kind(&file.to_string_lossy()), "file");

    let missing = temp.path().join("does_not_exist");
    assert_eq!(get_path_kind(&missing.to_string_lossy()), "missing");
}

#[test]
fn test_get_file_sizes() {
    let temp = TempDirGuard::new("quivit_file_sizes");
    let file1 = temp.path().join("first.bin");
    let file2 = temp.path().join("second.bin");
    fs::write(&file1, vec![0u8; 16]).unwrap();
    fs::write(&file2, vec![0u8; 48]).unwrap();

    let missing = temp.path().join("missing.bin");
    let dir = temp.path().join("sub");
    fs::create_dir_all(&dir).unwrap();

    let p1 = file1.to_string_lossy().into_owned();
    let p2 = file2.to_string_lossy().into_owned();
    let p_missing = missing.to_string_lossy().into_owned();
    let p_dir = dir.to_string_lossy().into_owned();

    let sizes = get_file_sizes(vec![p1.clone(), p2.clone(), p_missing.clone(), p_dir.clone()]);

    assert_eq!(sizes.get(&p1), Some(&16));
    assert_eq!(sizes.get(&p2), Some(&48));
    assert_eq!(sizes.get(&p_missing), None);
    assert_eq!(sizes.get(&p_dir), None);
}

#[test]
fn test_read_and_write_text_file() {
    let temp = TempDirGuard::new("quivit_text_io");
    let target = temp.path().join("sub").join("nested.txt");
    let target_str = target.to_string_lossy().into_owned();

    let utf8_content = "UTF-8 test: Hello, 世界! 🦀\nLine 2 with \t tabs & accents: é, è, ö.";
    let write_res = write_text_file(target_str.clone(), utf8_content.to_string());
    assert!(write_res.is_ok());

    let read_res = read_text_file(target_str);
    assert_eq!(read_res.unwrap(), utf8_content);

    let missing_str = temp.path().join("absent.txt").to_string_lossy().into_owned();
    let missing_res = read_text_file(missing_str);
    assert!(missing_res.is_err());
}

#[test]
fn test_read_gallery_metadata_parsing() {
    let temp = TempDirGuard::new("quivit_gallery_meta");

    let empty_dir = temp.path().join("empty");
    fs::create_dir_all(&empty_dir).unwrap();
    let (title, count, is_gallery) = read_gallery_metadata(&empty_dir);
    assert_eq!(title, None);
    assert_eq!(count, 0);
    assert!(!is_gallery);

    let valid_dir = temp.path().join("valid");
    fs::create_dir_all(&valid_dir).unwrap();
    fs::write(
        valid_dir.join("gallery.json"),
        r#"{"title":"Art Collection","images":[{"filename":"1.jpg"},{"filename":"2.png"},{"filename":"3.webp"}]}"#,
    )
    .unwrap();
    let (title, count, is_gallery) = read_gallery_metadata(&valid_dir);
    assert_eq!(title.as_deref(), Some("Art Collection"));
    assert_eq!(count, 3);
    assert!(is_gallery);

    let malformed_dir = temp.path().join("malformed");
    fs::create_dir_all(&malformed_dir).unwrap();
    fs::write(malformed_dir.join("gallery.json"), "invalid json").unwrap();
    let (title, count, is_gallery) = read_gallery_metadata(&malformed_dir);
    assert_eq!(title, None);
    assert_eq!(count, 0);
    assert!(!is_gallery);
}

#[test]
fn test_find_directory_metadata() {
    let non_existent = std::env::temp_dir().join(format!(
        "quivit_non_existent_meta_{}_{}",
        std::process::id(),
        SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    ));
    let res = find_directory_metadata(non_existent.to_string_lossy().into_owned()).unwrap();
    assert!(res.is_none());

    let temp = TempDirGuard::new("quivit_meta_outside");
    fs::write(temp.path().join("comicinfo.xml"), "<ComicInfo/>").unwrap();
    let outside_res = find_directory_metadata(temp.to_str()).unwrap();
    assert!(outside_res.is_none());

    let empty_dir = TempDirGuard::new("quivit_meta_empty");
    let empty_res = find_directory_metadata(empty_dir.to_str()).unwrap();
    assert!(empty_res.is_none());

    let gallery_dir = TempDirGuard::new("quivit_meta_gallery");
    fs::write(
        gallery_dir.path().join("gallery.json"),
        r#"{"title":"Sample","images":[]}"#,
    )
    .unwrap();
    let gallery_res = find_directory_metadata(gallery_dir.to_str()).unwrap();
    assert!(gallery_res.is_none());
}

#[test]
fn test_remove_directory_safety() {
    let non_existent = std::env::temp_dir().join(format!(
        "quivit_non_existent_{}_{}",
        std::process::id(),
        SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    ));
    let res_async = tauri::async_runtime::block_on(remove_directory(
        non_existent.to_string_lossy().into_owned(),
    ));
    assert!(res_async.is_ok());

    let res_sync = remove_directory_impl(non_existent.to_string_lossy().into_owned());
    assert!(res_sync.is_ok());

    let outside_temp = TempDirGuard::new("quivit_outside_removal");
    let res_outside = remove_directory_impl(outside_temp.to_str());
    assert_eq!(
        res_outside.unwrap_err(),
        "Cannot remove path outside of library root"
    );

    let res_root_drive = remove_directory_impl("C:\\".to_string());
    assert!(res_root_drive.is_err());

    if let Ok(lib_dir) = crate::commands::shell::get_library_dir() {
        let res_lib_root = remove_directory_impl(lib_dir);
        assert_eq!(
            res_lib_root.unwrap_err(),
            "Cannot remove path outside of library root"
        );
    }
}
