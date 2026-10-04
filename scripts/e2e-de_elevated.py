"""Relaunch a command at medium integrity from an elevated shell.

Usage:
    python scripts/e2e-de_elevated.py -- <cmd> [args...]
    python scripts/e2e-de_elevated.py --cwd <dir> -- <cmd> [args...]
    python scripts/e2e-de_elevated.py --check

Why this exists: WebView2 remote debugging never opens its DevTools port
under a High/System integrity tree, so wdio always dies there in
DevToolsActivePort timeouts. The normal `npm run e2e` path keeps its
fail-fast stop message. Only the `--agent` wrapper calls here so an
elevated harness keeps moving instead of stalling the agent.

How it works (stdlib only, no ps1, no new deps):
1. Non-Windows or non-elevated: run the command directly.
2. Windows elevated: duplicate the medium-integrity token from the
   running explorer.exe and launch with inherited console handles and
   inherited environment, so E2E_LAYOUT, QUIVIT_CONFIG_DIR, and friends
   survive the hop. The token decides integrity, the env stays as-is on
   purpose. Tries CreateProcessAsUser first, then CreateProcessWithToken
   (the latter only needs SeImpersonatePrivilege, which a stock elevated
   shell holds, while SeAssignPrimaryTokenPrivilege is usually absent).
3. Last resort: print the historical elevated stop message, exit 2.

Exit code is always the child exit code, or 2 for infrastructure.
"""

import ctypes
import os
import subprocess
import sys


ELEVATED_MESSAGE = (
    "E2E runs under an elevated shell. WebView2 remote debugging does not "
    "attach there; re-run from a non-elevated terminal."
)


def is_elevated_win():
    try:
        import ctypes

        return ctypes.windll.shell32.IsUserAnAdmin() != 0
    except Exception:
        pass
    try:
        out = subprocess.run(
            ["whoami", "/groups"], capture_output=True, text=True, timeout=15
        ).stdout or ""
        return "S-1-16-12288" in out or "S-1-16-16384" in out
    except Exception:
        return False


def run_direct(cmd, cwd):
    res = subprocess.run(cmd, cwd=cwd)
    return res.returncode


def _win32():
    import ctypes
    from ctypes import wintypes

    kernel = ctypes.windll.kernel32
    advapi = ctypes.windll.advapi32

    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.GetLastError.restype = wintypes.DWORD
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.GetStdHandle.argtypes = [wintypes.DWORD]
    kernel.GetStdHandle.restype = wintypes.HANDLE
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.WaitForSingleObject.restype = wintypes.DWORD
    kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel.GetExitCodeProcess.restype = wintypes.BOOL

    advapi.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
    advapi.OpenProcessToken.restype = wintypes.BOOL
    advapi.LookupPrivilegeValueW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, ctypes.c_void_p]
    advapi.LookupPrivilegeValueW.restype = wintypes.BOOL
    advapi.AdjustTokenPrivileges.argtypes = [
        wintypes.HANDLE, wintypes.BOOL, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p, ctypes.c_void_p,
    ]
    advapi.AdjustTokenPrivileges.restype = wintypes.BOOL
    advapi.DuplicateTokenEx.argtypes = [
        wintypes.HANDLE, wintypes.DWORD, ctypes.c_void_p, wintypes.INT, wintypes.INT,
        ctypes.POINTER(wintypes.HANDLE),
    ]
    advapi.DuplicateTokenEx.restype = wintypes.BOOL
    advapi.CreateProcessAsUserW.argtypes = [
        wintypes.HANDLE, wintypes.LPCWSTR, wintypes.LPWSTR, ctypes.c_void_p, ctypes.c_void_p,
        wintypes.BOOL, wintypes.DWORD, ctypes.c_void_p, wintypes.LPCWSTR, ctypes.c_void_p, ctypes.c_void_p,
    ]
    advapi.CreateProcessAsUserW.restype = wintypes.BOOL
    advapi.CreateProcessWithTokenW.argtypes = [
        wintypes.HANDLE, wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.DWORD,
        ctypes.c_void_p, wintypes.LPCWSTR, ctypes.c_void_p, ctypes.c_void_p,
    ]
    advapi.CreateProcessWithTokenW.restype = wintypes.BOOL
    return kernel, advapi


class _LUID(ctypes.Structure):
    _fields_ = [("LowPart", ctypes.c_ulong), ("HighPart", ctypes.c_long)]


class _TOKEN_PRIVILEGES(ctypes.Structure):
    _fields_ = [("PrivilegeCount", ctypes.c_ulong), ("Luid", _LUID), ("Attributes", ctypes.c_ulong)]


def _enable_privilege(priv_name):
    try:
        import ctypes
        from ctypes import wintypes

        kernel, advapi = _win32()
        h_token = wintypes.HANDLE()
        if not advapi.OpenProcessToken(
            kernel.GetCurrentProcess(), 0x20 | 0x8, ctypes.byref(h_token)
        ):
            return False
        try:
            luid = _LUID()
            if not advapi.LookupPrivilegeValueW(None, priv_name, ctypes.byref(luid)):
                return False
            tp = _TOKEN_PRIVILEGES(1, luid, 0x2)
            if not advapi.AdjustTokenPrivileges(h_token, False, ctypes.byref(tp), 0, None, None):
                return False
            return kernel.GetLastError() == 0
        finally:
            kernel.CloseHandle(h_token)
    except Exception:
        return False


def _find_explorer_pid():
    import ctypes
    from ctypes import wintypes

    kernel, _ = _win32()
    TH32CS_SNAPPROCESS = 0x00000002
    MAX_PATH = 260

    class PROCESSENTRY32W(ctypes.Structure):
        _fields_ = [
            ("dwSize", wintypes.DWORD),
            ("cntUsage", wintypes.DWORD),
            ("th32ProcessID", wintypes.DWORD),
            ("th32DefaultHeapID", ctypes.c_void_p),
            ("th32ModuleID", wintypes.DWORD),
            ("cntThreads", wintypes.DWORD),
            ("th32ParentProcessID", wintypes.DWORD),
            ("pcPriClassBase", wintypes.LONG),
            ("dwFlags", wintypes.DWORD),
            ("szExeFile", wintypes.WCHAR * MAX_PATH),
        ]

    kernel.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.c_void_p]
    kernel.Process32FirstW.restype = wintypes.BOOL
    kernel.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.c_void_p]
    kernel.Process32NextW.restype = wintypes.BOOL

    snap = kernel.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if snap == wintypes.HANDLE(-1).value:
        return None
    try:
        entry = PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
        if not kernel.Process32FirstW(snap, ctypes.byref(entry)):
            return None
        while True:
            if entry.szExeFile.lower() == "explorer.exe":
                return int(entry.th32ProcessID)
            if not kernel.Process32NextW(snap, ctypes.byref(entry)):
                return None
    finally:
        kernel.CloseHandle(snap)


def _startup_info(kernel):
    import ctypes
    from ctypes import wintypes

    class STARTUPINFOW(ctypes.Structure):
        _fields_ = [
            ("cb", wintypes.DWORD),
            ("lpReserved", wintypes.LPWSTR),
            ("lpDesktop", wintypes.LPWSTR),
            ("lpTitle", wintypes.LPWSTR),
            ("dwX", wintypes.DWORD),
            ("dwY", wintypes.DWORD),
            ("dwXSize", wintypes.DWORD),
            ("dwYSize", wintypes.DWORD),
            ("dwXCountChars", wintypes.DWORD),
            ("dwYCountChars", wintypes.DWORD),
            ("dwFillAttribute", wintypes.DWORD),
            ("dwFlags", wintypes.DWORD),
            ("wShowWindow", wintypes.WORD),
            ("cbReserved2", wintypes.WORD),
            ("lpReserved2", ctypes.c_void_p),
            ("hStdInput", wintypes.HANDLE),
            ("hStdOutput", wintypes.HANDLE),
            ("hStdError", wintypes.HANDLE),
        ]

    class PROCESS_INFORMATION(ctypes.Structure):
        _fields_ = [
            ("hProcess", wintypes.HANDLE),
            ("hThread", wintypes.HANDLE),
            ("dwProcessId", wintypes.DWORD),
            ("dwThreadId", wintypes.DWORD),
        ]

    si = STARTUPINFOW()
    si.cb = ctypes.sizeof(STARTUPINFOW)
    si.dwFlags = 0x00000100
    si.hStdInput = kernel.GetStdHandle(-10)
    si.hStdOutput = kernel.GetStdHandle(-11)
    si.hStdError = kernel.GetStdHandle(-12)
    return si, PROCESS_INFORMATION()


def _wait_process(kernel, pi):
    import ctypes
    from ctypes import wintypes

    try:
        kernel.WaitForSingleObject(pi.hProcess, 0xFFFFFFFF)
        code = wintypes.DWORD()
        if not kernel.GetExitCodeProcess(pi.hProcess, ctypes.byref(code)):
            raise RuntimeError("GetExitCodeProcess failed")
        return int(code.value)
    finally:
        kernel.CloseHandle(pi.hThread)
        kernel.CloseHandle(pi.hProcess)
def _duplicate_explorer_token():
    import ctypes
    from ctypes import wintypes

    kernel, advapi = _win32()
    pid = _find_explorer_pid()
    if pid is None:
        raise RuntimeError("explorer.exe not found for medium token")
    h_process = kernel.OpenProcess(0x0400, False, pid)
    if not h_process:
        raise RuntimeError("OpenProcess(explorer) failed")
    try:
        h_token = wintypes.HANDLE()
        if not advapi.OpenProcessToken(h_process, 0x0002 | 0x0008, ctypes.byref(h_token)):
            raise RuntimeError("OpenProcessToken(explorer) failed")
        return kernel, advapi, h_token
    finally:
        kernel.CloseHandle(h_process)


def _create_medium_process(cmd, cwd):
    import ctypes
    from ctypes import wintypes

    kernel, advapi, h_token = _duplicate_explorer_token()
    try:
        _enable_privilege("SeAssignPrimaryTokenPrivilege")
        _enable_privilege("SeIncreaseQuotaPrivilege")
        _enable_privilege("SeImpersonatePrivilege")
        cmdline = subprocess.list2cmdline(cmd)
        errors = []

        h_primary = wintypes.HANDLE()
        if advapi.DuplicateTokenEx(h_token, 0x02000000, None, 2, 1, ctypes.byref(h_primary)):
            try:
                si, pi = _startup_info(kernel)
                buf = ctypes.create_unicode_buffer(cmdline)
                if advapi.CreateProcessAsUserW(
                    h_primary, None, buf, None, None, True, 0, None, cwd,
                    ctypes.byref(si), ctypes.byref(pi),
                ):
                    return _wait_process(kernel, pi)
                errors.append(f"AsUser={kernel.GetLastError()}")
            finally:
                kernel.CloseHandle(h_primary)
        else:
            errors.append("dup-primary failed")

        h_imp = wintypes.HANDLE()
        if advapi.DuplicateTokenEx(h_token, 0x02000000, None, 2, 2, ctypes.byref(h_imp)):
            try:
                si, pi = _startup_info(kernel)
                buf = ctypes.create_unicode_buffer(cmdline)
                if advapi.CreateProcessWithTokenW(
                    h_imp, 0, None, buf, 0, None, cwd, ctypes.byref(si), ctypes.byref(pi),
                ):
                    return _wait_process(kernel, pi)
                errors.append(f"WithToken={kernel.GetLastError()}")
            finally:
                kernel.CloseHandle(h_imp)
        else:
            errors.append("dup-impersonation failed")

        raise RuntimeError("medium launch failed (" + ", ".join(errors) + ")")
    finally:
        kernel.CloseHandle(h_token)


def main(argv):
    args = list(argv)
    cwd = None
    if "--cwd" in args:
        idx = args.index("--cwd")
        if idx + 1 >= len(args):
            print("missing value for --cwd", file=sys.stderr)
            return 2
        cwd = args[idx + 1]
        del args[idx : idx + 2]
    if "--check" in args:
        if os.name != "nt":
            print("not-elevated (non-windows)", file=sys.stderr)
            return 0
        print(
            "elevated" if is_elevated_win() else "not-elevated",
            file=sys.stderr,
        )
        return 2 if is_elevated_win() else 0
    if args and args[0] == "--":
        args = args[1:]
    if not args:
        print("usage: python scripts/e2e-de_elevated.py [--cwd DIR] -- <cmd> [args...]", file=sys.stderr)
        return 2
    if os.environ.get("E2E_ALLOW_ELEVATED"):
        return run_direct(args, cwd)
    if os.name != "nt" or not is_elevated_win():
        return run_direct(args, cwd)
    print("[e2e-de_elevated] elevated shell; relaunching at medium integrity...", file=sys.stderr)
    os.environ["E2E_DEELEVATED"] = "1"
    try:
        return _create_medium_process(args, cwd)
    except Exception as err:
        print(f"[e2e-de_elevated] medium launch failed ({err})", file=sys.stderr)
    print(ELEVATED_MESSAGE, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
