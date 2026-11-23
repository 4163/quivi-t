# Archiver temp-extraction subfolder investigation

**Question.** For temp files created when you open an image directly from inside an archive (double-click or Enter on an entry in Explorer, WinRAR, 7-Zip, etc., which extracts the entry to `C:\Users\x4163\AppData\Local\Temp\...\file` and launches the viewer), can we tell **from that temp path alone** whether the original entry was at the root or inside a subfolder (e.g. `New folder\...`), without probing the archiver's running process or its window, and if not, is there any reliable hash or sidecar that encodes it?

**Method.** live clipboard capture, on-disk temp forensics while opening entries, binary string extraction, registry inspection, source-code lookup (7-Zip `CPP/Windows/FileDir.cpp`, PeaZip `peach.pas`/`list_utils.pas`), and web search per archiver. All programs installed on this machine and exercised against the same fixture `E:\Projects\QuiviT\test-files\_archives\zip.zip` which contains the same file at **both** `export_1785518835803.apng` (root, `624000` bytes, CRC `CBA7C688`) and `New folder\export_1785518835803.apng` (identical size/CRC) to force ambiguity.

**Answer in one paragraph.** Three engines **do** preserve the hierarchy in the temp path and are therefore 100% inferable from the path alone, Explorer `zipfldr.dll`, WinZip (`wz` prefix), and PeaZip (`peazip-tmp\.ptmp`), while four engines **deliberately flatten** to `temp\<random>\<basename>`, 7-Zip, NanaZip, WinRAR, and Bandizip. Their random directory names are `GetTickCount`/`PID`/`rand` based, contain no CRC, no archive name, no ADS, and no sidecar that survives the drop. Without reading the archiver's live window text, address bar, command line, or history registry, the clipboard path alone **cannot** disambiguate `root\file` vs `subfolder\file` when the two share the same basename/size. Guessing by name or size will pick the wrong entry on the duplicate-name fixture.

I expected at least one of the flattening engines to leave a breadcrumb. They do not. 7-Zip and Bandizip especially feel frustrating, because the temp name looks technical enough to be decodable, but it is just tick noise. That is the whole trap here. If you trust the path alone on those four, you will flip manga pages.

---

## 1. Raw clipboard evidence

| Archiver | Non-subfolder (entry at root) | Subfolder case (`New folder\...`) | Subfolder visible in path? |
|---|---|---|---|
| **Windows Explorer** (`zipfldr.dll`) | `...\Temp\8c8b0bbf-a0e0-48b1-bd41-8a199b9c66e5_zip.zip.6e5\export_1785518835803.apng` | `...\Temp\8fa2de21-bee0-40f5-b9a5-aa9c0e20449d_zip.zip.49d\New folder\export_1785518835803.apng` | **Yes** |
| **WinRAR** | `...\Temp\Rar$DIa19052.17864.rartemp\export_1785518835803.apng` | `...\Temp\Rar$DIa20180.20230.rartemp\export_1785518835803.apng` | **No**, both flat |
| **NanaZip** (MS Store fork) | `...\Temp\7zO81809E5E\export_1785518835803.apng` | `...\Temp\7zO81872ACE\export_1785518835803.apng` | **No** |
| **7-Zip** | `...\Temp\7zO0564639E\export_1785518835803.apng` | `...\Temp\7zO05640B31\export_1785518835803.apng` | **No** |
| **WinZip** | `...\Temp\wz013b\export_1785518835803.apng` | `...\Temp\wz78dc\New folder\export_1785518835803.apng` | **Yes** |
| **PeaZip** | `...\Temp\peazip-tmp\.ptmp0F5E47\export_1785518835803.apng` | `...\Temp\peazip-tmp\.ptmp0F5E47\New folder\export_1785518835803.apng` | **Yes** (same random dir, hierarchy under it) |
| **Bandizip** | `...\Temp\BNZ.6aa4604625b3e2d\export_1785518835803.apng` | `...\Temp\BNZ.6aa4606a25bcc15\export_1785518835803.apng` | **No** |

Fixture: `E:\Projects\QuiviT\test-files\_archives\zip.zip` (`55008910` bytes) contains:

```
export_1785518835803.apng (root)
New folder/export_1785518835803.apng (subfolder, same 624000 bytes)
```

`7z.exe l -slt zip.zip` shows both with `Size = 624000`, `CRC = CBA7C688`.

---

## 2. Per-archiver deep dive

### 2.1 Windows Explorer, `CompressedFolder` (`zipfldr.dll`)

**Temp anatomy.** `C:\Users\x4163\AppData\Local\Temp\<uuid>_zip.zip.<suffix>\...`

* Example leaf `8c8b0bbf-a0e0-48b1-bd41-8a199b9c66e5_zip.zip.6e5`, first part is a UUID via `UuidCreate`/`UuidToStringW`, second part is the archive basename, suffix is **last 3 hex chars of the UUID** (validated: `...b9c66e5` → `.6e5`, `...c0e20449d` → `.49d`). All 8 live dirs at `C:\Users\x4163\AppData\Local\Temp\????????-????-????-????-????????????_zip.zip.???` validated on 2026-09-12.
* Source: `HKCR\CompressedFolder` → `C:\Windows\system32\zipfldr.dll` (`10.0.19041.5915`, `309248` bytes, `2025-06-11`), imports `GetTempPathW`, `GetTempFileName`, `UuidCreate`, `PathCchAppend`, `ReadWriteTempFile`, `ZipExtract` (strings at `shell\ext\zip\dropin.cpp`, `idataobj.cpp`). Shell handler `DelegateExecute {11dbb47c-a525-400b-9e80-a54615a090c0}` in `HKCR\CompressedFolder\Shell\Open`.
* **Subfolder behavior.** unconditional hierarchy replication. The data object is `CFSTR_FILEDESCRIPTORW` + `CFSTR_FILECONTENTS`; `dropin.cpp` creates the UUID dir under `%TEMP%` and replicates stored paths verbatim. There is **no "Use Folder Names" toggle**, Explorer has no such option. Clipboard confirms `New folder\` preserved; all live dirs inspected with `tree /F` contain the full relative path.
* **Reliability.** ~100%. Only failure modes are `MAX_PATH` clipping or illegal-char sanitization (both rare for manga archives).

### 2.2 WinZip, `wz` prefix

**Temp anatomy.** `C:\Users\x4163\AppData\Local\Temp\wzXXXX\...` (`XXXX` = 4 hex chars). Clipboard `wz013b`, `wz78dc`; no `wz????` dirs remain after drop (aggressive cleanup). Pattern is `GetTempFileNameW` with prefix `wz`.

* Local: `C:\Program Files\WinZip\winzip64.exe` (`117,808,096` bytes, v77.1), `HKCU\Software\Nico Mak Computing\WinZip\WinZip` with `ZipTemp=C:\Users\x4163\AppData\Local\Temp`, MRU `mru\archives\0=E:\...\zip.zip`. Docs `kb.winzip.com/en/130688` + `dev-kb.winzip.com/HELP_DIR.htm`: temp location is `%TMP%`/`%TEMP%` or `C:\...\Temp`.
* **Subfolder behavior.** conditional on `Unzip Settings → Use Folder Names` (`kb.winzip.com/en/130698`). When checked (default when `Wizard=0`), hierarchy preserved, clipboard `wz78dc\New folder\...`. When unchecked, extraction flattens to `wzXXXX\file` even for nested entries. So **~99% on default installs, but not 100% across user machines**. The Folders tab itself does not control this.
* **Reliability.** treat as Explorer-like: if the relative path after the `wzXXXX` leaf contains `\` or `/`, trust it; otherwise it is ambiguous.

### 2.3 PeaZip, `peazip-tmp\.ptmp` prefix

**Temp anatomy.** `C:\Users\x4163\AppData\Local\Temp\peazip-tmp\.ptmpXXXXXX\...` where `XXXXXX` is 6-char URL-safe base64.

* Source `peazip-src/peazip-sources/dev/list_utils.pas:184` `STR_PZWORKTMP='peazip-tmp'`, `:188` `STR_TMP='.ptmp'`, `peach.pas:37916` `create_ptmpcode` → `randfn` at `:3362` (`random(68719000000)` → `base64str(@i,SizeOf(i))`), root assembled at `peach.pas:29103` `peaziptmpdirroot+STR_PZWORKTMP+DirectorySeparator`. Binary `C:\Program Files\PeaZip\pea.exe` contains `peazip-tmp/.ptmp` markers.
* **Subfolder behavior.** hierarchy always preserved under the random leaf. PeaZip delegates to `7z`/`pea` backends with full paths; clipboard shows **same** random dir `.ptmp0F5E47` for both root and subfolder files, with `New folder\` as a subdirectory on the subfolder case. This is the only archiver where one random dir holds multiple files with structure.
* **Reliability.** ~99%. No config toggle affects it. The only edge is stale `peazip-tmp` after reboot (empty per `peach.pas:34792` `cleardir`).

### 2.4 7-Zip, `7zO` prefix

**Temp anatomy.** `C:\Users\x4163\AppData\Local\Temp\7zO<8-hex>\file` (flat).

* Source `CPP/Windows/FileDir.cpp:MyGetTempPath` / `CTempDir::Create`:
 ```cpp
 UInt32 d = (GetTickCount()<<12) ^ (GetCurrentThreadId()<<14) ^ GetCurrentProcessId();
 for(8 nibbles) s[k] = hex(d & 0xF); d>>=4;
 d += GetTickCount()+2; // up to 100 retries on collision
 ```
 Caller `CPP/7zip/UI/FileManager/PanelItemOpen.cpp:30` `#define kTempDirPrefix FTEXT("7zO")` (the drag code path `PanelDrag.cpp:80` uses `7zE`, the viewer open path uses `7zO`; both share the same flat-file logic). Local `C:\Program Files\7-Zip\7zFM.exe` (26.03, `1,003,520` bytes) strings contain `GetTempPathW`+`GetTickCount`+`srand`/`rand`; no `7zO` literal in `7z.dll` because prefix is caller-supplied.
* **Why flat?** `PanelItemOpen.cpp:CPanel::OpenItemInArchive`:
 ```cpp
 UString name = GetItemName(index); // basename only
 FString tempFilePath = tempDirNorm + us2fs(Get_Correct_FsFile_Name(name));
 ```
 `Get_Correct_FsFile_Name` strips `/` and separators. Folder prefix is discarded. Live `Get-ChildItem ...\7zO* -Recurse`, all 22 dirs flat, `HasSubfolder=False`, `FileCount=1` (validated `7zO81809E5E\export...`, `7zO81872ACE\export...` both `624000` bytes, no subdirectory).
* **Hash decode?** No for archive entry or subfolder recovery. `7zO0564639E` vs `7zO05640B31` share high nibbles `0564` (per-process tick), low nibbles vary per open. Doing `7z.exe l -slt` on the fixture shows both entries CRC `CBA7C688`; the hashes do not equal the CRC and differ despite identical CRCs. The first three hex nibbles do leak the low 12 bits of the creator process ID because 7-Zip emits the temp hash low-nibble first. That can filter live 7-Zip/NanaZip windows, but it still cannot recover root vs subfolder without the live UI.
* **NanaZip**, identical fork: `C:\Program Files\WindowsApps\40174MouriNaruto.NanaZip_7.0.1832.0_x64__gnj4mf6z9tkrc\NanaZip.Modern.FileManager.exe` unicode `7zO` at `450940`/`7zE` at `444808`, same `GetTempPathW` imports, same `%TEMP%` location (not `Packages\TempState`, empty), flat behavior confirmed by NanaZip clipboard pair.

### 2.5 WinRAR, `Rar$` / `.rartemp`

**Temp anatomy.** `C:\Users\x4163\AppData\Local\Temp\Rar$DIa<PID>.<rand>.rartemp\file` (flat) for viewer open, `Rar$DRa` is the equivalent prefix when the same file is dragged out.

* Docs `WinRAR.chm` + `Rar.txt:2543` describe temp as `%TEMP%`/`-w`. `HKCU\Software\WinRAR` has no `Paths\TempFolder` override on this machine. Binary UTF-16 dump shows `Rar$` prefixes at file offsets `2061048` (`LS`), `2067672` (`DR`), `2152384` (`Rar$`+`\rartemp\`), `.rartemp` at `2135864` adjacent to `Zone.Identifier` template. `DI`= dialog/viewer extraction, `DR`= drag. Construction is `GetTempPathW` + `Rar$DIa<PID>.<rand>.rartemp` (`%u.%u` near `2136122`). Verified: `Rar$DIa19052.17864` → PID `19052`, `Rar$DIa20180.20230` → `20180`; live PIDs at scan time `21136/21448/21916` matched magnitude.
* **Subfolder.** GUI viewer/drag extracts **single file flat** per `HELPInterfaceViewing.htm` ("unpacks this file to a temporary folder"). Both clipboard specimens flat despite archive containing duplicate names. CLI `Rar.exe x` *does* preserve hierarchy to real dest, but temp-viewer path does not.
* **Hash decode?** Second number is tick/random, not CRC. Duplicates of same size produce different suffixes; no encoding of archive or entry name. `dir /r` shows no ADS; `Get-Item -Stream *` shows only `:$DATA`.

### 2.6 Bandizip, `BNZ.` prefix

**Temp anatomy.** `C:\Users\x4163\AppData\Local\Temp\BNZ.xxxxxxxxxxxxxxx\file` (flat). Clipboard `BNZ.6aa4604625b3e2d` = `6aa46046`+`25b3e2d` (8+7 hex, `"%sBNZ.%x%x\~bz.thumb.*"` at `Bandizip.exe:0x2A5F44`, imports `GetTempPathW`), `BNZ.6aa4606a25bcc15` = `6aa4606a`+`25bcc15` (high 32 tick-derived `delta high=0x24`, low `0x8DE8`). Second open of same file gives different folder → per-open randomness, not per-archive.

* Local `C:\Program Files\Bandizip\Bandizip.exe` (`3,487,088` bytes, v8.21 Build `71822`), `ark.x64.dll` (`2,292,104`) has no `BNZ`, generator in UI exe. `HKCU\Software\Bandizip` `setUserTempPath=0`, `userTempPath=C:\...\Temp\`, no archive→BNZ mapping. No ADS; flat extraction matches 7-Zip/WinRAR: drag via OLE bypasses destination knowledge, extracts to temp then Explorer moves.

---

## 3. The hash: can it be reversed without probing?

**No.** Exhaustive check:

* **7-Zip/NanaZip `7zO` 8 hex.** `GetTickCount`+`ThreadId`+`ProcessId` random. Opposite of CRC, two entries with same CRC map to different hashes. Not decodable into an entry path; listing `7zO*` and brute-forcing each archive's fingerprint cannot invert because same basename+size+Crc maps to multiple `7zO` dirs. The low 12 process ID bits are usable only as a live-window filter.
* **WinRAR suffix `<rand>`.** same tick random. `17864` vs `20230` differ for same file; no hidden base64 of path.
* **Bandizip `BNZ.%x%x`.** 60-bit tick, `int(hex,16)` gives e.g. `480273294912339501` not an epoch-ms, no archive-name encoding.
* **Explorer UUID + suffix.** UUIDv4 random; suffix is just last 3 hex of UUID, not content.
* **WinZip `wz` 4 hex.** low-word of tick, random.
* **PeaZip `.ptmp` 6-char base64.** `random(68719000000)` → base64, random.
* **ADS / sidecar.** `Get-Item -Stream *` on all live temps shows only `:$DATA`; no `Zone.Identifier` with entry path (that template string in WinRAR binary is MOTW, not used for path). `Packages\TempState`, `Bandizip.ini` (`config.ini`), `HKCU\Software\7-Zip\FM\PanelPath0` etc. exist but none map `temp dir → entry subfolder`, only archive-level history.
* **Listing `%TEMP%` and scanning every archive for a size/name match.** would find *candidates*, but with duplicate-basename fixtures (`root\file` vs `sub\file` identical size) it cannot tell which one was dragged. Age or recency only narrows to "recent."

---

## 4. What you can trust without probing

| Engine | Temp root | Subfolder in clipboard path? | Trust path alone? | "Hash" useful? |
|---|---|---|---|---|
| **Explorer** `zipfldr` | `%TEMP%\<uuid>_zip.zip.<3hex>` | Yes | **Yes, 100%** | No, UUID random, suffix is UUID tail |
| **WinZip** | `%TEMP%\wz<4hex>` | Yes (iff *Use Folder Names* checked) | **~99%** on defaults; add fallback if user disabled the option | No, 4-hex tick |
| **PeaZip** | `%TEMP%\peazip-tmp\.ptmp<6b64>` | Yes (under random leaf) | **Yes, 99%** | No, 6-char random |
| **7-Zip** | `%TEMP%\7zO<8hex>` | No | **No** | No for subfolders; low PID bits can filter live windows |
| **NanaZip** | `%TEMP%\7zO<8hex>` (same) | No | **No** | No for subfolders; same low PID hint |
| **WinRAR** | `%TEMP%\Rar$DIa<PID>.<rand>.rartemp` | No | **No** | PID extractable, rand not |
| **Bandizip** | `%TEMP%\BNZ.<15hex>` | No | **No** | No, `%x%x` tick |

For the four flat engines, **no hash, no ADS, no file-time, no sidecar, and no dir-listing trick recovers the subfolder from the path alone**, especially on the duplicate-basename fixture where size alone cannot disambiguate. The only non-guessing signals are live archiver UI state (window title / address bar) or command line / MRU history.

---

## 5. Alternatives considered and why they fail alone

* **`FileGroupDescriptorW` / `IDataObject` before temp write.** The OLE drop *does* carry the relative name in the descriptor before Explorer materializes it to temp. A drop-target handler that registers `CFSTR_FILEDESCRIPTORW` could read the entry path before it hits disk for drag-and-drop, but this report is about opening directly from the archive, double-click or Enter, where there is no `IDropTarget` drag. That handler does not fire for viewer launch, so it does not solve the double-click case.
* **NTFS `Zone.Identifier` ADS / `IAttachmentExecute` provenance.** WinRAR's binary contains the `Zone.Identifier` template near the `Rar$` strings, but `Get-Item -Stream *` on live temps shows no such stream, only `:$DATA`. Bandizip/7-Zip do not write it for temp-view. Not viable.
* **Brute-force archive scan by size/name.** Enumerates every archive and looks for a matching entry by size-gated fallback. Fails on `root\a` vs `sub\a` with equal sizes (e.g., `624000`); the chooser would need to guess and could silently pick the wrong page, flipping manga reading order.
* **Dir-listing oldest-first or newest-first.** `7zO*` dirs are created per-drag, but scanning `C:\Temp\7zO*` sorted by `CreationTime` still cannot map *which* `7zO` dir corresponds to *which* entry when only the basename is known. Age only narrows to "recent."
* **Registry/MRU alone.** `HKCU\Software\WinRAR\ArcHistory`, `HKCU\Software\7-Zip\FM\PanelPath0`/`FolderHistory`, NanaZip `User.dat` contain archive paths and sometimes the last visited subfolder, but they lag the current view, e.g., after navigating into `New folder`, `PanelPath0` may still hold `E:\...\zip.zip` without suffix. Only the live window is authoritative.

---

## 6. Recommended detection per archiver (synthesized from subagent reports)

| Archiver | What subagents probed | Recommended reliable detection |
|---|---|---|
| **Explorer** `zipfldr` | UUID dir `...\<uuid>_zip.zip.<suffix>` verified via `UuidCreate`/`UuidToStringW` in `zipfldr.dll`; `tree /F` showed `New folder\` always under UUID leaf | **Path-only.** The relative path after the `<uuid>_zip.zip.<suffix>` leaf already contains `New folder/...`, trust it verbatim. No PID or ADS needed. If the relative path contains `/`, use it; else it is truly root. |
| **PeaZip** | `peazip-tmp\.ptmpXXXXXX` source at `list_utils.pas:184`/`peach.pas:37916` `random(68719000000)` → base64; binary `pea.exe` markers `peazip-tmp/.ptmp`; clipboard shows **same** `.ptmp0F5E47` for root+subfile with `New folder\` underneath | **Path-only** (same leaf, hierarchy underneath). Treat like Explorer: the relative path after the `.ptmpXXXXXX` leaf already encodes `New folder/...`. Size-gate the match to disambiguate duplicate basenames. Markers to look for are `peazip-tmp` and `\.ptmp` and the leaf `\.ptmp[0-9A-Za-z]{6}`. |
| **WinZip** | `wzXXXX` 4-hex via `GetTempFileNameW("wz")`; docs `kb.winzip.com/en/130698` `Use Folder Names` checkbox | **Path-only when hierarchical, fallback otherwise.** If the relative path contains `/`, trust it (`wz78dc\New folder\...`). If flat (`wz013b\file`) it is ambiguous, may be true root **or** user disabled *Use Folder Names*. Do not invent subfolder; fall back to basename matching with size gating. Marker is `\wz[0-9a-f]{3,4}`. |
| **7-Zip / NanaZip** | `7zO<8hex>` from `CPP/Windows/FileDir.cpp` `CTempDir::Create` `(GetTickCount<<12) ^ (GetCurrentThreadId<<14) ^ GetCurrentProcessId()`, `#define kTempDirPrefix "7zO"` at `PanelItemOpen.cpp:30` (`7zE` for drag); `PanelItemOpen.cpp` `GetItemName` + `Get_Correct_FsFile_Name` strips folder prefix → verified flat `Get-ChildItem ...\7zO* -Recurse` 22 dirs `FileCount=1`; NanaZip `NanaZip.Modern.FileManager.exe` unicode `7zO` at `450940` same logic, `%TEMP%` not `Packages\TempState` | **Live UI probing, no path-only subfolder alternative.** Decode the first three `7zO` hex nibbles in reverse order to get the low 12 bits of the creator process ID. Use that to prefer the matching live 7-Zip/NanaZip window when one exists. Enumerate all desktops (`WinSta0` → `EnumDesktopsW` → `EnumDesktopWindows`, critical for NanaZip `exebox-* AppContainer`) → `GetWindowTextW` on top-level + `EnumChildWindows` → `SendMessageTimeoutW(WM_GETTEXT,200ms)` on `Edit`/`ComboBox`/`ComboBoxEx32`, parsed by the 7-Zip address bar format (`E:\...\zip.zip\New folder - 7-Zip`) and window title. Registry `PanelPath0`/`FolderHistory` and NanaZip `User.dat` supply archive candidates only. If the PID hint exists but no live window matches it, ignore unrelated live 7-Zip/NanaZip subfolder context and fall back to non-live candidates. If no PID hint exists and live 7-Zip/NanaZip windows disagree for the same archive, clear the subfolder hint and fail closed on duplicate basenames. |
| **WinRAR** | `Rar$DIa<PID>.<rand>.rartemp` (`Rar$DRa` on drag) at offsets `2061048`/`2152384`, `.rartemp` at `2135864` next to `Zone.Identifier` template (not used); PID `19052/20180` extracted from leaf; GUI viewer doc "unpacks this file to a temporary folder" → flat; CLI `Rar.exe x` preserves but not temp-viewer | **Live UI probing, PID-anchored.** PID is extractable from the leaf (`Rar$DIa19052.17864` → `19052`). Then enumerate windows for that PID and read title `rar.rar\New folder - RAR archive...` via the WinRAR address bar format (`prefix = archive_filename + "\"` case-insensitive). Supplement with running process command lines (`WinRAR.exe "E:\...\rar.rar"`) and registry `HKCU\Software\WinRAR\ArcHistory` (0..9). No hash. On duplicate basename with same size and no `known_subfolder`, do not guess root. |
| **Bandizip** | `BNZ.<15hex>` = `BNZ.%x%x` at `Bandizip.exe:0x2A5F44` + `~bz.thumb.*`, `ark.x64.dll` no `BNZ` (UI exe); `HKCU\Software\Bandizip` `userTempPath`; observed `BNZ.6aa4604625b3e2d` flat even for nested entry, same OLE `Temp`→`Explorer moves` mechanism as 7-Zip | **Live UI probing, needs Bandizip window enum.** Running process scan catches `Bandizip.exe` via `bandi`, but the 7-Zip window enum misses `Arkview.x64.exe` (`Arkview`/`Bandizip` class, title `archive.zip - Bandizip`). Add enumeration for `Arkview`/`Bandizip` and address bar `Edit`/`ComboBoxEx32` via a `parse_bandizip_address_bar` analogous to the 7-Zip one. Fallback `BNZ.` is tick random, not decodable. Marker is `BNZ.` / `~bz.thumb`. |

**Cross-cut note on ambiguous duplicates.** When the relative path is flat and multiple archive entries share the same basename **and** size (fixture `CBA7C688`/`624000`), do not silently pick the root. Fail closed or prompt. Size-gated matching should be tiered (exact relative, case-insensitive, suffix, filename-only) and when still ambiguous and no `known_subfolder` was recovered, do not guess.

---

## 7. Sources

* Clipboard capture `Get-Clipboard -Raw` 2026-09-12 (all 7 archiver pairs verbatim above).
* Live temp forensics `Get-ChildItem C:\Users\x4163\AppData\Local\Temp` (UUID dirs `011b0b98...`, `324515e1...`; `7zO*` 22 flat dirs; `peazip-tmp` hierarchy).
* `C:\Program Files\7-Zip\7zFM.exe` / `7z.dll`, `C:\Program Files\WinRAR\WinRAR.exe`, `C:\Program Files\Bandizip\Bandizip.exe` (`Bandizip 8.21`, `BNZ.%x%x` at `0x2A5F44`), `C:\Program Files\PeaZip\pea.exe` (`peazip-tmp`/`\.ptmp` at `0x2C1D`), `C:\Program Files\WinZip\winzip64.exe`.
* `CPP/Windows/FileDir.cpp` (`CTempDir::Create`, `GetTickCount` hash) + `CPP/7zip/UI/FileManager/PanelItemOpen.cpp:30` (`kTempDirPrefix`), `peach.pas:37914`/`list_utils.pas:184-188,3362` (`peazip-tmp`/`ptmp`/`randfn`), `Rar.txt:2543`/`WinRAR.chm` (`%TEMP%`/`Rar$`), `zipfldr.dll` (`UuidCreate`, `HKCR\CompressedFolder`, `shell\ext\zip\dropin.cpp`).
* Registry `HKCU\Software\WinRAR\ArcHistory`, `HKCU\Software\7-Zip\FM\PanelPath0`/`FolderHistory` (`REG_BINARY` UTF-16LE), `HKCU\Software\Bandizip`, `HKCU\Software\Nico Mak Computing\WinZip\WinZip`, `Packages\NanaZip`.

---

## 8. Caveat: open-vs-extract

All of the above concerns **opening a file directly from inside an archive** (double-click or Enter on an entry, which extracts that single entry to `%TEMP%` and launches the associated viewer via `CF_HDROP` / command line). This is not about the archiver's explicit **Extract to...** command, which bypasses `%TEMP%` entirely, writes to a user-chosen folder, and preserves hierarchy by definition; no temp reasoning is needed there. Drag-and-drop uses the same per-file `%TEMP%` handoff with the same flattening behavior, but the clipboard report here was captured from direct opens, not drags. Bandizip/PeaZip "Extract here" with default "use folder names" similarly avoids the problem.

---

## 9. Working-tree resolution of flattening engine subfolder loop (7-Zip, NanaZip, WinRAR)

During implementation, 7-Zip, NanaZip, and WinRAR were selecting subfolders even when opening files from the archive root. The current fix passed manual runtime verification across Explorer ZIP, Bandizip, WinZip, PeaZip, 7-Zip, NanaZip, and the tested edge cases.

Two root causes were diagnosed:
1. `FolderHistory` in `HKCU\Software\7-Zip\FM` records visited directory history (for example `zip.zip\New folder\`). Parsing subfolders from history caused stale paths to be treated as active views, and candidate deduplication was letting non-empty subfolder strings overwrite root findings (`Some("")`).
2. WinRAR root window titles (`zip.zip - WinRAR`) and address bar strings (`zip.zip\`) failed the subfolder regex check, returning `None` instead of explicit root (`Some("")`), falling back to stale registry history.

The resolution:
- Stale registry histories (`FolderHistory`, `ArcHistory`) only supply candidate archive paths on disk (`known_subfolder: None`). They never determine subfolders.
- The live archiver window and child address bar controls (`WM_GETTEXT` on `Edit` and `ComboBox`) are the sole authority for active subfolder resolution in flattening engines.
- WinRAR root title parsing and address bar parsing recognize archive filenames both with and without trailing slashes as explicit root (`Some("")`).
- 7-Zip and NanaZip address bar inspection (`get_7z_address_bar`) inspects toolbar `ComboBox` and `Edit` controls when title text alone does not supply the full path.
- 7-Zip and NanaZip decode the low 12 process ID bits from the `7zO` temp folder and prefer live windows whose PID matches that hint.
- If that PID hint exists but no live 7-Zip/NanaZip window matches it, QuiviT ignores unrelated live subfolder context rather than borrowing a stale window state.
- Candidate deduplication preserves live window root detections. If no PID hint exists and live root/subfolder reports still conflict for the same archive, QuiviT clears the subfolder hint and fails closed instead of choosing a stale subfolder.
- The backend treats `std::env::temp_dir()` as the temp-root authority and rejects lookalike paths such as `E:\work\temp\...` before origin resolution.
- Native candidate discovery runs before the `ArchiveCache` write lock is acquired; the lock is held only while verifying candidate archive entries.
- Ambiguous duplicate entries fail closed safely to flat disk mode when no live window context is available.

---

## 10. NanaZip AppContainer Desktop Model and Animation Freeze Fix

### NanaZip AppContainer window discovery and XAML AddressBar UI Automation
NanaZip runs as an MSIX packaged application in an AppContainer sandbox. Windows creates private desktops for Centennial sandboxes named `exebox-*` under window station `WinSta0`.
Calling `EnumWindows` from standard processes only enumerates the caller thread desktop (`WinSta0\Default`). As a result, NanaZip top-level windows (`NanaZip.Modern.FileManager`) were invisible to standard window enumeration.
To locate NanaZip windows, `enumerate_top_level_windows` opens `WinSta0` and enumerates all child desktops via `EnumDesktopsW`. Each desktop (including active `exebox-*` containers) is opened with `OpenDesktopW` and enumerated via `EnumDesktopWindows`. Window handles are deduplicated across desktops.

Unlike classic 7-Zip, NanaZip modern UI (`NanaZip.Modern.FileManager`) does not update its Win32 top-level window title when navigating inside subfolders. The Win32 title remains static at the archive root (`...\zip.zip\`), and NanaZip uses modern XAML Islands rather than Win32 `ComboBox`/`Edit` controls for its address bar.
Calling Windows UI Automation from the main thread fails because of desktop boundaries. To resolve active subfolders in NanaZip:
1. When enumerating top-level windows on an `exebox-*` desktop, `get_nanazip_address_bar` spawns a dedicated worker thread attached via `SetThreadDesktop(hdesk)` to that desktop.
2. The worker initializes COM MTA, instantiates `IUIAutomation` via `CUIAutomation8`, and searches for descendant element with `AutomationId == "TextBoxElement"`.
3. Reading `UIA_ValueValuePropertyId` retrieves the live address bar text (for example `E:\...\zip.zip\New folder\`).
4. In `collect_candidates`, NanaZip and 7-Zip candidates are first filtered by the low 12 process ID bits decoded from the `7zO` folder. If no live window matches that hint, the resolver ignores those live windows and falls back to non-live candidates.
5. When NanaZip is closed, recent archive candidates are parsed from NanaZip virtualized registry hive at `%LOCALAPPDATA%\Packages\40174MouriNaruto.NanaZip_*\SystemAppData\Helium\User.dat`.

### Animation playback freeze resolution
Animated images intermittently rendered as static images due to four distinct factors:
1. **CPU Lanczos scaler race.** In `viewerPipelines.js`, `usesLanczos` was computed before `useWebGlForLanczos` was evaluated. When viewing animated files under Lanczos scaling, the CPU Lanczos renderer ran an 80ms delayed still-frame paint to `lanczosCanvas` and set `data-render-ready="true"`. CSS `#viewer-img-wrapper:has(#viewer-lanczos-canvas[data-render-ready="true"]) .viewer-img` then hid the animated `<img>` under `opacity: 0 !important`. Recalculating `usesLanczos = scaling === 'lanczos' && !usesWebgl` prevents the CPU scaler from overriding animated playback.
2. **Immediate APNG animation status.** In `core.js`, `_state.isAnimated` is now initialized to `true` for both `.gif` and `.apng` files, eliminating initial static render passes while waiting for backend header inspection.
3. **Chromium animation timeline reset.** Activating an animated target in `viewerRender.js` appends `_reset=${Date.now()}` to `state.src`. This forces Chromium to start playback from frame 0 rather than remaining frozen at the final frame from prior playback or background preloading.
4. **WebCodecs APNG fallback.** Chromium `ImageDecoder` for `image/png` only decodes a single static frame for APNG files (`frameCount < 2`). When `ImageDecoder` cannot provide multi-frame decoding, `viewerPipelines` tears down the WebGL canvas, allowing the native `<img>` element to play smoothly.
