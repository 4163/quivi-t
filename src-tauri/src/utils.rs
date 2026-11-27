use base64::prelude::*;

pub fn base64_encode(bytes: &[u8]) -> String {
    BASE64_STANDARD.encode(bytes)
}

pub fn base64_decode(input: &str) -> Option<String> {
    base64_decode_bytes(input).and_then(|bytes| String::from_utf8(bytes).ok())
}

pub fn base64_decode_bytes(input: &str) -> Option<Vec<u8>> {
    let trimmed = input.trim_end_matches('=');
    if trimmed.as_bytes().iter().any(|&b| b == b'-' || b == b'_') {
        BASE64_URL_SAFE_NO_PAD.decode(trimmed).ok()
    } else {
        BASE64_STANDARD_NO_PAD.decode(trimmed).ok()
    }
}

pub fn url_decode(input: &str) -> String {
    if !input.as_bytes().contains(&b'%') {
        return input.to_string();
    }
    let bytes = input.as_bytes();
    let mut decoded: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
            if let Ok(val) = u8::from_str_radix(hex, 16) {
                decoded.push(val);
                i += 3;
                continue;
            }
        }
        decoded.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(decoded).unwrap_or_default()
}

#[cfg(test)]
#[path = "tests/utils_tests.rs"]
mod tests;
