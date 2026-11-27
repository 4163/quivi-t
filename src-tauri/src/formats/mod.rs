mod animation;
mod dimensions;
mod isobmff;
mod registry;
mod tiff;

pub use animation::check_animation_status;
pub(crate) use animation::{gif_has_transparency, png_has_alpha};

pub use dimensions::{
    read_avif_dimensions, read_dimensions_from_bytes, read_ico_dimensions,
    read_jpeg_dimensions_from_reader, read_media_dimensions_from_path,
    read_media_dimensions_from_stream, read_svg_dimensions,
};
pub(crate) use dimensions::{ico_has_alpha, parse_ico_dir};

pub use isobmff::{
    check_mp4_has_audio, check_mp4_has_audio_stream, read_mp4_dimensions,
    read_mp4_dimensions_stream,
};
pub(crate) use isobmff::isobmff_box;

pub use registry::{
    FileFormat, FormatCategory, SUPPORTED_FORMATS, guess_mime, is_archive_ext, is_image_ext,
    is_metadata_ext, is_tiff_ext, is_tiff_name,
};
pub(crate) use registry::FORMAT_ICONS;

pub use tiff::{decode_tiff_file_to_png, decode_tiff_to_png, read_tiff_dimensions_from_reader};
pub(crate) use tiff::tiff_has_alpha;

#[cfg(test)]
#[path = "../tests/format_tests.rs"]
mod tests;
