
pub fn ico_frames_from_bytes(data: &[u8]) -> Result<String, String> {
    // Parse the ICO directory header directly to find all image entries,
    // then decode each sub-image individually.
    if data.len() < 6 {
        return Err("File too small to be an ICO".into());
    }
    
    // ICO header: reserved(2) + type(2) + count(2)
    let count = u16::from_le_bytes([data[4], data[5]]) as usize;
    if count == 0 || data.len() < 6 + count * 16 {
        return Err("Invalid ICO file structure".into());
    }
    
    let mut frames: Vec<image::DynamicImage> = Vec::new();
    
    for i in 0..count {
        let entry_offset = 6 + i * 16;
        let offset = u32::from_le_bytes([
            data[entry_offset + 12],
            data[entry_offset + 13],
            data[entry_offset + 14],
            data[entry_offset + 15],
        ]) as usize;
        let size = u32::from_le_bytes([
            data[entry_offset + 8],
            data[entry_offset + 9],
            data[entry_offset + 10],
            data[entry_offset + 11],
        ]) as usize;
        
        if offset + size > data.len() {
            continue;
        }
        
        let frame_data = &data[offset..offset + size];
        
        // Try to decode as PNG first (modern ICOs embed PNG)
        if frame_data.starts_with(b"\x89PNG") {
            match image::load_from_memory_with_format(frame_data, image::ImageFormat::Png) {
                Ok(image) => {
                    frames.push(image);
                }
                Err(_) => continue,
            }
        } else {
            // BMP frame - try to decode by creating a synthetic single-entry ICO
            // Create a minimal ICO file with just this one BMP entry
            let mut synthetic_ico = Vec::new();
            synthetic_ico.extend_from_slice(&[0, 0, 1, 0, 1, 0]); // ICO header with count=1
            synthetic_ico.extend_from_slice(&data[entry_offset..entry_offset + 12]); // Copy directory entry (width, height, etc.)
            // Adjust offset to point right after the 6+16 byte header
            synthetic_ico.extend_from_slice(&[22, 0, 0, 0]); // New offset = 22
            synthetic_ico.extend_from_slice(frame_data); // Append the BMP data
            
            match image::load_from_memory_with_format(&synthetic_ico, image::ImageFormat::Ico) {
                Ok(image) => {
                    frames.push(image);
                }
                Err(_) => continue,
            }
        }
    }
    
    if frames.is_empty() {
        // Last resort: just load the whole ICO
        let img = image::load_from_memory_with_format(&data, image::ImageFormat::Ico)
            .map_err(|e| format!("Failed to decode ICO: {e}"))?;
        frames.push(img);
    }
    
    // Sort largest to smallest for a consistent left-to-right order
    frames.sort_by(|a, b| b.width().cmp(&a.width()));
    // Deduplicate by width/height
    frames.dedup_by(|a, b| a.width() == b.width() && a.height() == b.height());
    
    let total_width: u32 = frames.iter().map(|f| f.width()).sum();
    let max_height: u32 = frames.iter().map(|f| f.height()).max().unwrap_or(0);
    
    let mut spritesheet = image::RgbaImage::new(total_width, max_height);
    let mut x_offset = 0u32;
    for frame in &frames {
        let rgba = frame.to_rgba8();
        let y_offset = (max_height - rgba.height()) / 2;
        image::imageops::replace(&mut spritesheet, &rgba, x_offset as i64, y_offset as i64);
        x_offset += rgba.width();
    }
    
    // Encode as PNG and return as data-URL
    let mut png_bytes: Vec<u8> = Vec::new();
    {
        use image::ImageEncoder;
        let encoder = image::codecs::png::PngEncoder::new(&mut png_bytes);
        encoder
            .write_image(
                spritesheet.as_raw(),
                spritesheet.width(),
                spritesheet.height(),
                image::ColorType::Rgba8.into(),
            )
            .map_err(|e| format!("Failed to encode PNG: {e}"))?;
    }
    
    let b64 = crate::utils::base64_encode(&png_bytes);
    Ok(format!("data:image/png;base64,{b64}"))
}

