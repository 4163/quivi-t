use aom_decode::avif::ParsedAvifData;

fn boxes(bytes: &[u8]) -> impl Iterator<Item = ([u8; 4], &[u8])> {
    let mut position = 0usize;
    std::iter::from_fn(move || {
        let (size, header, kind) = crate::formats::isobmff_box(bytes, position)?;
        let end = position
            .checked_add(size)
            .filter(|end| *end <= bytes.len())?;
        let body = bytes.get(position.checked_add(header)?..end)?;
        position = end;
        Some((kind, body))
    })
}

fn child<'a>(bytes: &'a [u8], kind: &[u8; 4]) -> Option<&'a [u8]> {
    boxes(bytes).find_map(|(name, body)| (&name == kind).then_some(body))
}

pub(super) fn is_avif(bytes: &[u8]) -> bool {
    let Some(brands) = child(bytes, b"ftyp") else {
        return false;
    };
    brands
        .get(..4)
        .into_iter()
        .chain(
            brands
                .get(8..)
                .into_iter()
                .flat_map(|brands| brands.chunks_exact(4)),
        )
        .any(|brand| brand == b"avif" || brand == b"avis")
}

fn u32_at(bytes: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_be_bytes(
        bytes.get(offset..offset.checked_add(4)?)?.try_into().ok()?,
    ))
}

fn u64_at(bytes: &[u8], offset: usize) -> Option<u64> {
    Some(u64::from_be_bytes(
        bytes.get(offset..offset.checked_add(8)?)?.try_into().ok()?,
    ))
}

struct Track<'a> {
    id: u32,
    reference: Option<u32>,
    alpha: bool,
    premultiplied: bool,
    config: &'a [u8],
    sample: &'a [u8],
}

fn track<'a>(file: &'a [u8], bytes: &'a [u8]) -> Option<Track<'a>> {
    let tkhd = child(bytes, b"tkhd")?;
    let id = u32_at(tkhd, if *tkhd.first()? == 1 { 20 } else { 12 })?;
    let table = child(child(child(bytes, b"mdia")?, b"minf")?, b"stbl")?;
    let samples = child(table, b"stsc")?;
    if u32_at(samples, 4)? == 0 || u32_at(samples, 8)? != 1 {
        return None;
    }
    let description = u32_at(samples, 16)?.checked_sub(1)? as usize;
    let descriptions = child(table, b"stsd")?;
    let (kind, entry) = boxes(descriptions.get(8..)?).nth(description)?;
    if &kind != b"av01" {
        return None;
    }
    let properties = entry.get(78..)?;
    let config = child(properties, b"av1C")?.get(4..)?;
    let size = if let Some(sizes) = child(table, b"stsz") {
        if u32_at(sizes, 8)? == 0 {
            return None;
        }
        let fixed = u32_at(sizes, 4)?;
        if fixed == 0 {
            u32_at(sizes, 12)?
        } else {
            fixed
        }
    } else {
        let sizes = child(table, b"stz2")?;
        if u32_at(sizes, 8)? == 0 {
            return None;
        }
        match *sizes.get(7)? {
            4 => u32::from(*sizes.get(12)? >> 4),
            8 => u32::from(*sizes.get(12)?),
            16 => u32::from(u16::from_be_bytes(sizes.get(12..14)?.try_into().ok()?)),
            _ => return None,
        }
    } as usize;
    let offset = if let Some(chunks) = child(table, b"stco") {
        if u32_at(chunks, 4)? == 0 {
            return None;
        }
        u64::from(u32_at(chunks, 8)?)
    } else {
        let chunks = child(table, b"co64")?;
        if u32_at(chunks, 4)? == 0 {
            return None;
        }
        u64_at(chunks, 8)?
    };
    let offset = usize::try_from(offset).ok()?;
    let sample = file.get(offset..offset.checked_add(size)?)?;
    let references = child(bytes, b"tref");
    let reference = references
        .and_then(|refs| child(refs, b"auxl"))
        .and_then(|refs| u32_at(refs, 0));
    let alpha = child(properties, b"auxi")
        .or_else(|| child(properties, b"auxC"))
        .is_some_and(|aux| aux.windows(5).any(|part| part == b"alpha"));
    let premultiplied = references.and_then(|refs| child(refs, b"prem")).is_some();
    Some(Track {
        id,
        reference,
        alpha,
        premultiplied,
        config,
        sample,
    })
}

fn payload(track: &Track<'_>) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(track.config.len() + track.sample.len());
    bytes.extend_from_slice(track.config);
    bytes.extend_from_slice(track.sample);
    bytes
}

pub(super) fn first_frame(bytes: &[u8]) -> Result<Option<ParsedAvifData>, String> {
    let Some(movie) = child(bytes, b"moov") else {
        return Ok(None);
    };
    let tracks: Vec<_> = boxes(movie)
        .filter(|(kind, _)| kind == b"trak")
        .filter_map(|(_, body)| track(bytes, body))
        .collect();
    let color = tracks
        .iter()
        .find(|track| !track.alpha && track.reference.is_none())
        .ok_or("AVIF sequence contains no readable AV1 image track.")?;
    let alpha = tracks
        .iter()
        .find(|track| track.alpha && track.reference == Some(color.id));
    let mut parsed = ParsedAvifData::default();
    parsed.primary_item = payload(color).into();
    parsed.alpha_item = alpha.map(|track| payload(track).into());
    parsed.premultiplied_alpha = color.premultiplied;
    Ok(Some(parsed))
}
