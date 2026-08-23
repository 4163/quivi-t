pub fn is_animated(bytes: &[u8]) -> bool {
    if bytes.len() < 8 {
        return false;
    }

    if bytes.starts_with(b"GIF8") {
        return check_gif(bytes);
    } else if bytes.starts_with(b"RIFF") && bytes.len() > 12 && &bytes[8..12] == b"WEBP" {
        return check_webp(bytes);
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return check_apng(bytes);
    }

    false
}

fn check_gif(bytes: &[u8]) -> bool {
    // Check for the Netscape looping block, which is virtually universal
    // in animated GIFs. (0x21, 0xFF, 0x0B, NETSCAPE2.0)
    bytes.windows(14).any(|w| w == b"\x21\xFF\x0BNETSCAPE2.0")
}

fn check_webp(bytes: &[u8]) -> bool {
    // Search for the VP8X chunk which contains the animation flag
    if let Some(pos) = bytes.windows(4).position(|w| w == b"VP8X") {
        if pos + 8 < bytes.len() {
            let flags = bytes[pos + 8];
            // ANIMATION flag is bit 1 (value 2)
            return (flags & 0b0000_0010) != 0;
        }
    }
    false
}

fn check_apng(bytes: &[u8]) -> bool {
    let actl_pos = bytes.windows(4).position(|w| w == b"acTL");
    let idat_pos = bytes.windows(4).position(|w| w == b"IDAT");

    match (actl_pos, idat_pos) {
        (Some(a), Some(i)) => a < i,
        (Some(_), None) => true,
        _ => false,
    }
}
