#!/usr/bin/env python3
"""
Generates test fixtures for archive encryption and corruption unit tests.
Creates:
  - encrypted.zip (password: 123)
  - encrypted.7z  (password: 123)
  - encrypted.rar (password: 123)
  - corrupt_local_header.zip (valid 01.png, corrupt local header on corrupt.png)
"""

import os
import shutil
import subprocess
import sys
import tempfile
import zipfile

PASSWORD = "123"

# Minimal valid 1x1 PNG byte sequence
PNG_BYTES = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x06\x00\x00\x00\x1f\x15c4\x00\x00\x00\nIDATx\x9cc\x00\x01\x00"
    b"\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82"
)
XML_BYTES = b"<ComicInfo><Title>Test Archive</Title></ComicInfo>"


def find_7z():
    candidates = [
        os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\WindowsApps\NanaZipC.exe"),
        r"C:\Program Files\7-Zip\7z.exe",
        r"C:\Program Files (x86)\7-Zip\7z.exe",
        shutil.which("NanaZipC"),
        shutil.which("7z"),
        shutil.which("7za"),
    ]
    for c in candidates:
        if c and os.path.exists(c):
            return c
    return None


def find_rar():
    candidates = [
        r"C:\Program Files\WinRAR\rar.exe",
        r"C:\Program Files (x86)\WinRAR\rar.exe",
        shutil.which("rar"),
        shutil.which("winrar"),
    ]
    for c in candidates:
        if c and os.path.exists(c):
            return c
    return None


def make_corrupt_zip(dest_path):
    with tempfile.TemporaryDirectory() as td:
        raw_zip = os.path.join(td, "temp.zip")
        with zipfile.ZipFile(raw_zip, "w") as z:
            z.writestr("01.png", PNG_BYTES)
            z.writestr("corrupt.png", PNG_BYTES)

        with open(raw_zip, "rb") as f:
            data = bytearray(f.read())

        idx = data.find(b"corrupt.png")
        if idx == -1:
            raise RuntimeError("Failed to locate corrupt.png in zip stream")

        header_pos = data.rfind(b"PK\x03\x04", 0, idx)
        if header_pos == -1:
            raise RuntimeError("Failed to find PK\\x03\\x04 local header")

        # Invalidate the local header magic signature
        data[header_pos : header_pos + 4] = b"PK\x00\x00"

        with open(dest_path, "wb") as f:
            f.write(data)


def make_encrypted_archives(out_dir):
    os.makedirs(out_dir, exist_ok=True)

    with tempfile.TemporaryDirectory() as td:
        png_path = os.path.join(td, "01.png")
        xml_path = os.path.join(td, "ComicInfo.xml")
        with open(png_path, "wb") as f:
            f.write(PNG_BYTES)
        with open(xml_path, "wb") as f:
            f.write(XML_BYTES)

        # 1. Corrupt ZIP
        corrupt_zip = os.path.join(out_dir, "corrupt_local_header.zip")
        make_corrupt_zip(corrupt_zip)
        print(f"Created {corrupt_zip}")

        # 2. Encrypted ZIP & 7Z via 7z/NanaZip
        exe_7z = find_7z()
        if exe_7z:
            enc_zip = os.path.join(out_dir, "encrypted.zip")
            if os.path.exists(enc_zip):
                os.remove(enc_zip)
            subprocess.run(
                [exe_7z, "a", "-tzip", f"-p{PASSWORD}", enc_zip, png_path, xml_path],
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            print(f"Created {enc_zip}")

            enc_7z = os.path.join(out_dir, "encrypted.7z")
            if os.path.exists(enc_7z):
                os.remove(enc_7z)
            subprocess.run(
                [exe_7z, "a", "-t7z", f"-p{PASSWORD}", enc_7z, png_path, xml_path],
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            print(f"Created {enc_7z}")
        else:
            print("Warning: 7z / NanaZip CLI not found; skipped encrypted.zip and encrypted.7z")

        # 3. Encrypted RAR via WinRAR rar.exe
        exe_rar = find_rar()
        if exe_rar:
            enc_rar = os.path.join(out_dir, "encrypted.rar")
            if os.path.exists(enc_rar):
                os.remove(enc_rar)
            subprocess.run(
                [exe_rar, "a", "-ep", f"-p{PASSWORD}", enc_rar, png_path, xml_path],
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            print(f"Created {enc_rar}")
        else:
            print("Warning: WinRAR rar.exe not found; skipped encrypted.rar")


if __name__ == "__main__":
    script_dir = os.path.dirname(os.path.abspath(__file__))
    default_out = os.path.abspath(
        os.path.join(script_dir, "..", "..", "..", "..", "test-files", "_archives", "encrypted_tests")
    )
    target_dir = sys.argv[1] if len(sys.argv) > 1 else default_out
    make_encrypted_archives(target_dir)
